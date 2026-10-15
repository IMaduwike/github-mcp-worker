import { McpAgent } from "agents/mcp";
import OAuthProvider, {
  type OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  GITHUB_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
};

const API = "https://api.github.com";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "github-mcp-worker"
};

async function githubRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<any> {
  if (
    !path.startsWith("/") ||
    path.includes("..") ||
    path.startsWith("//")
  ) {
    throw new Error("Invalid GitHub API path");
  }

  const token = env.GITHUB_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is missing or empty in the deployed Worker."
    );
  }

  const response = await fetch(API + path, {
    ...init,
    headers: {
      ...HEADERS,
      Authorization: `Bearer ${token}`,
      ...(init.body
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init.headers || {})
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status}: ${body.slice(0, 1500)}`
    );
  }

  return body ? JSON.parse(body) : {};
}

export class GitHubMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "github-mcp-worker",
    version: "1.0.0"
  });

  async init() {
    // Diagnostic: verifies the actual token supplied by Cloudflare.
    this.server.tool(
      "github_whoami",
      "Check GitHub authentication and identify the authenticated account.",
      {},
      async () => {
        const token = this.env.GITHUB_TOKEN?.trim();

        if (!token) {
          return {
            content: [{
              type: "text",
              text: "GITHUB_TOKEN IS MISSING OR EMPTY."
            }],
            isError: true
          };
        }

        const response = await fetch(`${API}/user`, {
          headers: {
            ...HEADERS,
            Authorization: `Bearer ${token}`
          }
        });

        const body = await response.text();

        if (!response.ok) {
          return {
            content: [{
              type: "text",
              text:
                `GitHub authentication test returned HTTP ${response.status}.\n` +
                body.slice(0, 1500)
            }],
            isError: true
          };
        }

        const user = JSON.parse(body);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              login: user.login,
              id: user.id,
              html_url: user.html_url
            }, null, 2)
          }]
        };
      }
    );

    // General GitHub REST API access.
    this.server.tool(
      "github_api_request",
      "Make a GitHub REST API request. Supports repositories, files, issues, pull requests, branches, releases, and other endpoints allowed by the token.",
      {
        method: z.enum([
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE"
        ]),
        path: z.string(),
        body: z.unknown().optional()
      },
      async ({ method, path, body }) => {
        const result = await githubRequest(this.env, path, {
          method,
          ...(body !== undefined
            ? { body: JSON.stringify(body) }
            : {})
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // GitHub GraphQL.
    this.server.tool(
      "github_graphql",
      "Execute a GitHub GraphQL query or mutation.",
      {
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional()
      },
      async ({ query, variables }) => {
        const token = this.env.GITHUB_TOKEN?.trim();

        if (!token) {
          throw new Error("GITHUB_TOKEN is missing or empty.");
        }

        const response = await fetch(`${API}/graphql`, {
          method: "POST",
          headers: {
            ...HEADERS,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ query, variables })
        });

        const result: any = await response.json();

        if (!response.ok || result.errors) {
          throw new Error(
            `GraphQL error: ${JSON.stringify(result).slice(0, 1500)}`
          );
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // Search repositories.
    this.server.tool(
      "github_search_repositories",
      "Search GitHub repositories.",
      {
        query: z.string(),
        per_page: z.number().int().min(1).max(100).optional()
      },
      async ({ query, per_page }) => {
        const result = await githubRequest(
          this.env,
          `/search/repositories?q=${encodeURIComponent(query)}&per_page=${per_page ?? 10}`
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // List branches.
    this.server.tool(
      "github_list_branches",
      "List branches in a repository.",
      {
        owner: z.string(),
        repo: z.string(),
        per_page: z.number().int().min(1).max(100).optional()
      },
      async ({ owner, repo, per_page }) => {
        const result = await githubRequest(
          this.env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${per_page ?? 30}`
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // Dispatch a workflow.
    this.server.tool(
      "github_dispatch_workflow",
      "Run a GitHub Actions workflow.",
      {
        owner: z.string(),
        repo: z.string(),
        workflow_id: z.union([z.string(), z.number()]),
        ref: z.string(),
        inputs: z.record(z.string(), z.string()).optional()
      },
      async ({ owner, repo, workflow_id, ref, inputs }) => {
        await githubRequest(
          this.env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(String(workflow_id))}/dispatches`,
          {
            method: "POST",
            body: JSON.stringify({
              ref,
              ...(inputs ? { inputs } : {})
            })
          }
        );

        return {
          content: [{
            type: "text",
            text: "Workflow dispatch requested."
          }]
        };
      }
    );

    // List workflow runs.
    this.server.tool(
      "github_list_workflow_runs",
      "List GitHub Actions workflow runs.",
      {
        owner: z.string(),
        repo: z.string(),
        per_page: z.number().int().min(1).max(100).optional()
      },
      async ({ owner, repo, per_page }) => {
        const result = await githubRequest(
          this.env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=${per_page ?? 20}`
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // Cancel workflow run.
    this.server.tool(
      "github_cancel_workflow_run",
      "Cancel a workflow run.",
      {
        owner: z.string(),
        repo: z.string(),
        run_id: z.number().int()
      },
      async ({ owner, repo, run_id }) => {
        await githubRequest(
          this.env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run_id}/cancel`,
          { method: "POST" }
        );

        return {
          content: [{
            type: "text",
            text: "Workflow cancellation requested."
          }]
        };
      }
    );

    // Rerun workflow.
    this.server.tool(
      "github_rerun_workflow",
      "Rerun a workflow.",
      {
        owner: z.string(),
        repo: z.string(),
        run_id: z.number().int()
      },
      async ({ owner, repo, run_id }) => {
        await githubRequest(
          this.env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run_id}/rerun`,
          { method: "POST" }
        );

        return {
          content: [{
            type: "text",
            text: "Workflow rerun requested."
          }]
        };
      }
    );

    // List Codespaces.
    this.server.tool(
      "github_list_codespaces",
      "List Codespaces belonging to a GitHub user.",
      {
        owner: z.string()
      },
      async ({ owner }) => {
        const result = await githubRequest(
          this.env,
          `/users/${encodeURIComponent(owner)}/codespaces`
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // Create Codespace.
    this.server.tool(
      "github_create_codespace",
      "Create a Codespace for a repository.",
      {
        owner: z.string(),
        repo: z.string(),
        branch: z.string().optional(),
        machine: z.string().optional()
      },
      async ({ owner, repo, branch, machine }) => {
        const result = await githubRequest(
          this.env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/codespaces`,
          {
            method: "POST",
            body: JSON.stringify({
              ...(branch ? { ref: branch } : {}),
              ...(machine ? { machine } : {})
            })
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

    // Stop Codespace.
    this.server.tool(
      "github_stop_codespace",
      "Stop a Codespace.",
      {
        codespace_name: z.string()
      },
      async ({ codespace_name }) => {
        const result = await githubRequest(
          this.env,
          `/user/codespaces/${encodeURIComponent(codespace_name)}/stop`,
          { method: "POST" }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
    );

    // Delete Codespace.
    this.server.tool(
      "github_delete_codespace",
      "Delete a Codespace.",
      {
        codespace_name: z.string()
      },
      async ({ codespace_name }) => {
        await githubRequest(
          this.env,
          `/user/codespaces/${encodeURIComponent(codespace_name)}`,
          { method: "DELETE" }
        );

        return {
          content: [{
            type: "text",
            text: "Codespace deleted."
          }]
        };
      }
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char =>
    `&#${char.charCodeAt(0)};`
  );
}

function accessPage(action: string, error = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub MCP Authorization</title>
</head>
<body>
<h1>GitHub MCP Authorization</h1>
<p>Enter your private access code to continue.</p>
${error ? `<p>${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(action)}">
<input type="password" name="access_code"
 autocomplete="current-password" required>
<button type="submit">Continue</button>
</form>
</body>
</html>`;
}

function consentPage(
  details: Awaited<ReturnType<OAuthHelpers["describeConsent"]>>,
  handle: string,
  action: string
): string {
  const scopes = details.scope.map(scope =>
    `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`
  ).join("<br>");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize GitHub MCP</title>
</head>
<body>
<h1>Authorize ${escapeHtml(details.clientName)}</h1>
${details.clientDomain
    ? `<p>Publisher: <strong>${escapeHtml(details.clientDomain)}</strong></p>`
    : "<p>The publisher domain is not verified.</p>"}
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback
    ? "<p>Warning: this redirects to a local application.</p>"
    : ""}
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${scopes}
<br><br>
<button name="decision" value="approve">Allow</button>
<button name="decision" value="deny">Deny</button>
</form>
</body>
</html>`;
}

async function authorizationHandler(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== "/authorize") {
    return new Response("Not found", { status: 404 });
  }

  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };

  // Preserve the original OAuth parameters through every form submission.
  const action = url.pathname + url.search;

  if (request.method === "GET") {
    return new Response(accessPage(action), { headers });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST" }
    });
  }

  const form = await request.formData();

  // OAuth consent submission.
  if (form.has("handle")) {
    const handle = String(form.get("handle") || "");

    try {
      if (String(form.get("decision")) !== "approve") {
        const denied = await env.OAUTH_PROVIDER.denyConsent(
          request,
          handle
        );

        return new Response(null, {
          status: 302,
          headers: denied.headers
        });
      }

      const approved = await env.OAUTH_PROVIDER.approveConsent(
        request,
        handle,
        {
          scope: form.getAll("scope").map(String)
        }
      );

      const result =
        await env.OAUTH_PROVIDER.completeAuthorization({
          request: approved.request,
          userId: "neon-owner",
          metadata: {},
          scope: approved.request.scope,
          props: { userId: "neon-owner" }
        });

      approved.headers.set("Location", result.redirectTo);

      return new Response(null, {
        status: 302,
        headers: approved.headers
      });
    } catch {
      return new Response(
        "Authorization expired or invalid. Restart authorization from your MCP client.",
        { status: 400 }
      );
    }
  }

  // Check the private access code.
  const expected = env.MCP_ACCESS_TOKEN?.trim();
  const supplied = String(form.get("access_code") || "");

  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    return new Response(
      accessPage(action, "Invalid access code."),
      { status: 401, headers }
    );
  }

  try {
    const authRequest =
      await env.OAUTH_PROVIDER.parseAuthRequest(request);

    const details =
      await env.OAUTH_PROVIDER.describeConsent(authRequest);

    const consent =
      await env.OAUTH_PROVIDER.beginConsent(authRequest);

    consent.headers.set(
      "Content-Type",
      "text/html; charset=utf-8"
    );
    consent.headers.set("Cache-Control", "no-store");

    return new Response(
      consentPage(details, consent.handle, action),
      { headers: consent.headers }
    );
  } catch {
    return new Response(
      "Invalid OAuth request. Restart authorization from your MCP client.",
      { status: 400, headers }
    );
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);

  let difference = aa.length ^ bb.length;

  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    difference |= (aa[i] || 0) ^ (bb[i] || 0);
  }

  return difference === 0;
}

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: GitHubMCP.serve("/mcp"),
  defaultHandler: authorizationHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",

  scopesSupported: [
    "mcp:read",
    "mcp:write",
    "offline_access"
  ],

  resourceMetadata: {
    resource:
      "https://github-mcp-worker.ifeanyimaduwike.workers.dev/mcp",
    authorization_servers: [
      "https://github-mcp-worker.ifeanyimaduwike.workers.dev"
    ]
  },

  requiredScopes: ["mcp:read"],
  clientIdMetadataDocumentEnabled: true
});
