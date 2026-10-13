# GitHub MCP Worker

A GitHub MCP server designed to run on Cloudflare Workers.

## Features

- GitHub account information
- General GitHub REST API access
- GraphQL queries and mutations
- Repository search
- Branch listing
- GitHub Actions workflow dispatch, listing, cancellation, and reruns
- Codespaces management

## Secrets

Configure these as Cloudflare Worker secrets:

- GITHUB_TOKEN
- MCP_ACCESS_TOKEN

Never commit tokens to the repository or share them publicly.

## Endpoints

- GET /health
- /mcp — protected by MCP_ACCESS_TOKEN

## Status

Starter implementation. Dependencies and runtime behavior must be verified before production use.
