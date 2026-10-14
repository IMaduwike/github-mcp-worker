import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  GITHUB_TOKEN: string;
  MCP_ACCESS_TOKEN: "test123";
  GITHUB_MCP: DurableObjectNamespace;
};

const API = "https://api.github.com";

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

  const response = await fetch(API + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-mcp-worker",
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
    this.server.tool(
      "github_whoami",
      "Get the GitHub account associated with the configured token.",
      {},
      async () => {
        const data = await githubRequest(this.env, "/user");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              login: data.login,
              id: data.id,
              html_url: data.html_url
            }, null, 2)
          }]
        };
      }
    );

    this.server.tool(
      "github_api_request",
      "Make a GitHub REST API request. Supports repository operations, files, issues, pull requests, branches, releases, and more, subject to token permissions.",
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

    this.server.tool(
      "github_graphql",
      "Execute a GitHub GraphQL query or mutation.",
      {
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional()
      },
      async ({ query, variables }) => {
        const response = await fetch(
          "https://api.github.com/graphql",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
              "Content-Type": "application/json",
              "User-Agent": "github-mcp-worker"
            },
            body: JSON.stringify({ query, variables })
          }
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            `GraphQL error: ${JSON.stringify(result)}`
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
          `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`,
          {
            method: "POST",
            body: JSON.stringify({ ref, inputs })
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
          `/repos/${owner}/${repo}/actions/runs?per_page=${per_page ?? 20}`
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2).slice(0, 18000)
          }]
        };
      }
    );

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
          `/repos/${owner}/${repo}/actions/runs/${run_id}/cancel`,
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

    this.server.tool(
      "github_rerun_workflow",
      "Re-run a workflow.",
      {
        owner: z.string(),
        repo: z.string(),
        run_id: z.number().int()
      },
      async ({ owner, repo, run_id }) => {
        await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/actions/runs/${run_id}/rerun`,
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
          `/repos/${owner}/${repo}/codespaces`,
          {
            method: "POST",
            body: JSON.stringify({
              ref: branch,
              machine
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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "github-mcp-worker"
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    const env.MCP_ACCESS_TOKEN = "test123"
    if (
  request.headers.get("Authorization") !==
    "Bearer neon-mcp-test-2026-change-this"
) {
  return new Response("Unauthorized", { status: 401 });
}

    return GitHubMCP.serve("/mcp").fetch(request, env, ctx);
  }
};
