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

        // Read a repository's file tree.
    this.server.tool(
      "github_repo_tree",
      "List repository files and directories.",
      {
        owner: z.string(),
        repo: z.string(),
        ref: z.string().optional(),
        path_prefix: z.string().optional(),
      },
      async ({ owner, repo, ref, path_prefix }) => {
        const r = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref || "HEAD")}?recursive=1`
        );

        const entries = (r.tree || [])
          .filter((x: any) => !path_prefix || x.path.startsWith(path_prefix))
          .slice(0, 500);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              truncated: r.truncated,
              entries,
            }, null, 2).slice(0, 18000),
          }],
        };
      }
    );

    // Read a file with optional line ranges.
    this.server.tool(
      "github_read_file",
      "Read a repository file, optionally selecting line numbers.",
      {
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      async ({ owner, repo, path, ref, start_line, end_line }) => {
        if (path.startsWith("/") || path.split("/").includes("..")) {
          throw new Error("Invalid file path.");
        }

        const p = path.split("/").map(encodeURIComponent).join("/");
        const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";

        const r = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/contents/${p}${q}`
        );

        if (r.type !== "file" || !r.content) {
          throw new Error("Not a readable file.");
        }

        const decoded = atob(r.content.replace(/\s/g, ""));
        const content = new TextDecoder().decode(
          Uint8Array.from(decoded, c => c.charCodeAt(0))
        );

        const lines = content.split("\n");
        const start = Math.max(1, start_line || 1);
        const end = Math.min(lines.length, end_line || lines.length);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path,
              total_lines: lines.length,
              content: lines
                .slice(start - 1, end)
                .map((line, i) => `${start + i}: ${line}`)
                .join("\n"),
            }).slice(0, 18000),
          }],
        };
      }
    );

    // Search text in repository source files.
    this.server.tool(
      "github_repo_grep",
      "Search for text across a bounded number of repository source files.",
      {
        owner: z.string(),
        repo: z.string(),
        query: z.string().min(1),
        ref: z.string().optional(),
        path_prefix: z.string().optional(),
        max_files: z.number().int().min(1).max(100).optional(),
        case_sensitive: z.boolean().optional(),
      },
      async ({ owner, repo, query, ref, path_prefix, max_files, case_sensitive }) => {
        const tree = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref || "HEAD")}?recursive=1`
        );

        const files = (tree.tree || [])
          .filter((f: any) =>
            f.type === "blob" &&
            (f.size || 0) <= 200000 &&
            (!path_prefix || f.path.startsWith(path_prefix)) &&
            /\.(ts|tsx|js|jsx|py|cpp|h|hpp|json|md|yml|yaml|toml|go|rs|html|css|sh|txt)$/i.test(f.path)
          )
          .slice(0, max_files || 30);

        const matches: any[] = [];
        let scanned = 0;

        for (const file of files) {
          try {
            const p = file.path.split("/").map(encodeURIComponent).join("/");
            const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
            const data = await githubRequest(
              this.env,
              `/repos/${owner}/${repo}/contents/${p}${q}`
            );

            if (!data.content || data.encoding !== "base64") continue;

            const decoded = atob(data.content.replace(/\s/g, ""));
            const text = new TextDecoder().decode(
              Uint8Array.from(decoded, c => c.charCodeAt(0))
            );

            scanned++;
            const lines = text.split("\n");
            const needle = case_sensitive ? query : query.toLowerCase();

            for (let i = 0; i < lines.length; i++) {
              const hay = case_sensitive ? lines[i] : lines[i].toLowerCase();

              if (hay.includes(needle)) {
                matches.push({
                  path: file.path,
                  line: i + 1,
                  text: lines[i].slice(0, 300),
                });
              }

              if (matches.length >= 100) break;
            }
          } catch {
            // Skip files that cannot be read.
          }

          if (matches.length >= 100) break;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              scanned_files: scanned,
              matches,
              truncated: tree.truncated || matches.length >= 100,
            }, null, 2).slice(0, 18000),
          }],
        };
      }
    );

    // Commit several file changes together.
    this.server.tool(
      "github_multi_file_commit",
      "Create, update, or delete multiple repository files in one commit.",
      {
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        message: z.string(),
        changes: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          delete: z.boolean().optional(),
        })).min(1).max(50),
      },
      async ({ owner, repo, branch, message, changes }) => {
        const root = `/repos/${owner}/${repo}`;

        const seen = new Set<string>();

        for (const c of changes) {
          if (
            c.path.startsWith("/") ||
            c.path.includes("\\") ||
            c.path.split("/").some(s => !s || s === "." || s === "..")
          ) {
            throw new Error(`Invalid path: ${c.path}`);
          }

          if (seen.has(c.path)) {
            throw new Error(`Duplicate path: ${c.path}`);
          }

          seen.add(c.path);

          if (!c.delete && c.content === undefined) {
            throw new Error(`Missing content for ${c.path}`);
          }
        }

        const branchPath = branch
          .split("/")
          .map(encodeURIComponent)
          .join("/");

        const ref = await githubRequest(
          this.env,
          `${root}/git/ref/heads/${branchPath}`
        );

        const parentSha = ref.object.sha;

        const parent = await githubRequest(
          this.env,
          `${root}/git/commits/${parentSha}`
        );

        const entries: any[] = [];

        for (const c of changes) {
          if (c.delete) {
            entries.push({
              path: c.path,
              mode: "100644",
              type: "blob",
              sha: null,
            });
          } else {
            const blob = await githubRequest(
              this.env,
              `${root}/git/blobs`,
              {
                method: "POST",
                body: JSON.stringify({
                  content: c.content,
                  encoding: "utf-8",
                }),
              }
            );

            entries.push({
              path: c.path,
              mode: "100644",
              type: "blob",
              sha: blob.sha,
            });
          }
        }

        const tree = await githubRequest(
          this.env,
          `${root}/git/trees`,
          {
            method: "POST",
            body: JSON.stringify({
              base_tree: parent.tree.sha,
              tree: entries,
            }),
          }
        );

        const commit = await githubRequest(
          this.env,
          `${root}/git/commits`,
          {
            method: "POST",
            body: JSON.stringify({
              message,
              tree: tree.sha,
              parents: [parentSha],
            }),
          }
        );

        // Refuse to overwrite a branch that changed during this operation.
        const current = await githubRequest(
          this.env,
          `${root}/git/ref/heads/${branchPath}`
        );

        if (current.object.sha !== parentSha) {
          throw new Error(
            "Branch changed while preparing the commit. Retry to avoid overwriting newer changes."
          );
        }

        await githubRequest(
          this.env,
          `${root}/git/refs/heads/${branchPath}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              sha: commit.sha,
              force: false,
            }),
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              commit: commit.sha,
              url: commit.html_url,
              branch,
              changes: changes.map(c => ({
                path: c.path,
                action: c.delete ? "deleted" : "written",
              })),
            }, null, 2),
          }],
        };
      }
    );

    // Create a repository.
    this.server.tool(
      "github_create_repository",
      "Create a repository under the authenticated GitHub account.",
      {
        name: z.string().min(1),
        description: z.string().optional(),
        private: z.boolean().optional(),
        auto_init: z.boolean().optional(),
      },
      async ({ name, description, private: isPrivate, auto_init }) => {
        const result = await githubRequest(
          this.env,
          "/user/repos",
          {
            method: "POST",
            body: JSON.stringify({
              name,
              description: description || "",
              private: isPrivate ?? true,
              auto_init: auto_init ?? true,
            }),
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: result.full_name,
              private: result.private,
              url: result.html_url,
              default_branch: result.default_branch,
            }, null, 2),
          }],
        };
      }
    );

    // Delete a repository. This is destructive.
    this.server.tool(
      "github_delete_repository",
      "Permanently delete a repository. Requires explicit user authorization.",
      {
        owner: z.string(),
        repo: z.string(),
        confirm_repository_name: z.string(),
      },
      async ({ owner, repo, confirm_repository_name }) => {
        if (confirm_repository_name !== `${owner}/${repo}`) {
          throw new Error(
            `Confirmation must exactly match ${owner}/${repo}.`
          );
        }

        await githubRequest(
          this.env,
          `/repos/${owner}/${repo}`,
          { method: "DELETE" }
        );

        return {
          content: [{
            type: "text",
            text: `Repository ${owner}/${repo} was deleted.`,
          }],
        };
      }
    );

    // Clone a repository's Git content into a new repository.
    this.server.tool(
      "github_clone_repository",
      "Copy a source repository's files and directories into a newly created repository. Copies the selected ref's current tree, not full Git history.",
      {
        source_owner: z.string(),
        source_repo: z.string(),
        target_name: z.string().min(1),
        target_private: z.boolean().optional(),
        source_ref: z.string().optional(),
        description: z.string().optional(),
      },
      async ({
        source_owner,
        source_repo,
        target_name,
        target_private,
        source_ref,
        description,
      }) => {
        const sourceRoot = `/repos/${source_owner}/${source_repo}`;

        const source = await githubRequest(
          this.env,
          `${sourceRoot}/git/trees/${encodeURIComponent(source_ref || "HEAD")}?recursive=1`
        );

        if (source.truncated) {
          throw new Error(
            "Source tree is too large for a safe clone through this tool."
          );
        }

        const repo = await githubRequest(
          this.env,
          "/user/repos",
          {
            method: "POST",
            body: JSON.stringify({
              name: target_name,
              description: description || `Copy of ${source_owner}/${source_repo}`,
              private: target_private ?? true,
              auto_init: false,
            }),
          }
        );

        const targetRoot = `/repos/${repo.owner.login}/${repo.name}`;
        const entries: any[] = [];

        for (const item of source.tree || []) {
          if (item.type !== "blob") continue;

          if ((item.size || 0) > 500000) {
            throw new Error(
              `File ${item.path} exceeds the 500 KB per-file clone limit. The target repository may already have been created.`
            );
          }

          const blob = await githubRequest(
            this.env,
            `${sourceRoot}/git/blobs/${item.sha}`
          );

          entries.push({
            path: item.path,
            mode: item.mode || "100644",
            type: "blob",
            sha: item.sha,
          });
        }

        const tree = await githubRequest(
          this.env,
          `${targetRoot}/git/trees`,
          {
            method: "POST",
            body: JSON.stringify({ tree: entries }),
          }
        );

        const commit = await githubRequest(
          this.env,
          `${targetRoot}/git/commits`,
          {
            method: "POST",
            body: JSON.stringify({
              message: `Initial copy of ${source_owner}/${source_repo}`,
              tree: tree.sha,
              parents: [],
            }),
          }
        );

        await githubRequest(
          this.env,
          `${targetRoot}/git/refs`,
          {
            method: "POST",
            body: JSON.stringify({
              ref: "refs/heads/main",
              sha: commit.sha,
            }),
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: `${source_owner}/${source_repo}`,
              repository: repo.full_name,
              url: repo.html_url,
              files_copied: entries.length,
              commit: commit.sha,
              note: "This copies the selected ref's file tree. It does not copy branches, tags, or Git history.",
            }, null, 2),
          }],
        };
      }
    );

    // Create a branch from another ref.
    this.server.tool(
      "github_create_branch",
      "Create a branch from a branch, tag, or commit.",
      {
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        from_ref: z.string().optional(),
      },
      async ({ owner, repo, branch, from_ref }) => {
        if (
          !branch ||
          branch.startsWith("/") ||
          branch.includes("..") ||
          /[ ~^:?*[\]\\]/.test(branch)
        ) {
          throw new Error("Invalid branch name.");
        }

        const source = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/commits/${encodeURIComponent(from_ref || "HEAD")}`
        );

        const result = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/git/refs`,
          {
            method: "POST",
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha: source.sha,
            }),
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              branch: result.ref,
              sha: result.object.sha,
            }, null, 2),
          }],
        };
      }
    );

    // Open a pull request.
    this.server.tool(
      "github_create_pull_request",
      "Create a pull request from a head branch to a base branch.",
      {
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        head: z.string(),
        base: z.string(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
      },
      async ({ owner, repo, title, head, base, body, draft }) => {
        const result = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/pulls`,
          {
            method: "POST",
            body: JSON.stringify({
              title,
              head,
              base,
              body: body || "",
              draft: draft ?? false,
            }),
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              number: result.number,
              url: result.html_url,
              state: result.state,
              draft: result.draft,
            }, null, 2),
          }],
        };
      }
    );

    // Merge a pull request only when explicitly requested.
    this.server.tool(
      "github_merge_pull_request",
      "Merge a pull request when explicitly requested.",
      {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number().int().min(1),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
        expected_head_sha: z.string().optional(),
      },
      async ({ owner, repo, pull_number, merge_method, expected_head_sha }) => {
        const result = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/pulls/${pull_number}/merge`,
          {
            method: "PUT",
            body: JSON.stringify({
              merge_method: merge_method || "squash",
              ...(expected_head_sha ? { sha: expected_head_sha } : {}),
            }),
          }
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
        };
      }
    );

    // Read workflow failures and identify failed steps.
    this.server.tool(
      "github_read_workflow_failure",
      "Summarize failed jobs and steps for a GitHub Actions run.",
      {
        owner: z.string(),
        repo: z.string(),
        run_id: z.number().int().min(1),
      },
      async ({ owner, repo, run_id }) => {
        const result = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/actions/runs/${run_id}/jobs?per_page=100`
        );

        const failed = (result.jobs || [])
          .filter((j: any) => j.conclusion === "failure")
          .map((j: any) => ({
            name: j.name,
            url: j.html_url,
            failed_steps: (j.steps || [])
              .filter((s: any) => s.conclusion === "failure")
              .map((s: any) => ({
                name: s.name,
                number: s.number,
              })),
          }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ run_id, failed_jobs: failed }, null, 2),
          }],
        };
      }
    );

    // Read benchmark results stored in the repository.
    this.server.tool(
      "github_get_benchmark_results",
      "Read benchmark JSON committed to a repository.",
      {
        owner: z.string(),
        repo: z.string(),
        path: z.string().optional(),
        ref: z.string().optional(),
      },
      async ({ owner, repo, path, ref }) => {
        const filePath = path || "benchmarks/results.json";

        if (
          filePath.startsWith("/") ||
          filePath.split("/").includes("..")
        ) {
          throw new Error("Invalid file path.");
        }

        const p = filePath.split("/").map(encodeURIComponent).join("/");
        const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";

        const file = await githubRequest(
          this.env,
          `/repos/${owner}/${repo}/contents/${p}${q}`
        );

        if (!file.content || file.encoding !== "base64") {
          throw new Error("Benchmark file not found or not readable.");
        }

        const decoded = atob(file.content.replace(/\s/g, ""));
        const content = new TextDecoder().decode(
          Uint8Array.from(decoded, c => c.charCodeAt(0))
        );

        let results: unknown;

        try {
          results = JSON.parse(content);
        } catch {
          throw new Error("Benchmark file is not valid JSON.");
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path: filePath,
              results,
            }, null, 2).slice(0, 18000),
          }],
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
  defaultHandler: {
  fetch: authorizationHandler
},
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
