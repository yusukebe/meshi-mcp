# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

meshi-mcp は Cloudflare Workers 上で動作する Hono ベースの飯（グルメ）特化型 MCP サーバー。
yusukebe が飯屋を雑にMCP経由で登録し、みんながMCP経由で検索・閲覧できる。

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **MCP**: `@modelcontextprotocol/sdk` (WebStandardStreamableHTTPServerTransport)
- **Database**: Cloudflare D1 (SQLite)
- **Schema Validation**: Zod
- **Language**: TypeScript (strict mode, ESNext target)
- **Package Manager**: bun

## Commands

- `bun run dev` — ローカル開発サーバー起動 (wrangler dev)
- `bun run deploy` — Cloudflare Workers へデプロイ
- `bun run cf-typegen` — Worker設定からCloudflareBindings型を生成
- `bunx wrangler d1 migrations apply meshi-db --local` — D1マイグレーション適用（ローカル）

## Architecture

- エントリポイント: `src/index.ts` — Honoアプリ + MCPツール定義
- Worker設定: `wrangler.jsonc`
- D1マイグレーション: `migrations/`
- MCPエンドポイント: `POST /mcp`（ステートレスモード、リクエストごとにサーバー生成）

## MCP Tools

| ツール | 説明 |
|--------|------|
| `add_restaurant` | 飯屋登録（nameのみ必須） |
| `search_restaurants` | キーワード・エリア・ジャンルで検索 |
| `get_restaurant` | 詳細取得 |
| `update_restaurant` | 情報更新 |
| `delete_restaurant` | 削除 |
| `list_restaurants` | 一覧表示 |
