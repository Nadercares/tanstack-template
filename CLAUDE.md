# CLAUDE.md — AI Assistant Guide for tanstack-chat-template

This file provides context for AI assistants (Claude, Copilot, etc.) working in this repository.

---

## Project Overview

A full-stack AI chat application built with React 19, TanStack Router/Start, and Anthropic Claude. It features streaming AI responses, conversation management, customizable system prompts, optional Convex persistence, and optional Sentry error monitoring.

**Key technologies:**
- **Framework:** TanStack React Start (SSR + server functions via Vinxi)
- **Router:** TanStack Router v1 (file-based routing, auto code-splitting)
- **State:** TanStack Store v0.7 (local) + Convex v1 (optional persistence)
- **AI:** Anthropic SDK (`@anthropic-ai/sdk`) — Claude 3.5 Sonnet, streaming
- **Styling:** Tailwind CSS v4 (PostCSS plugin)
- **Monitoring:** Sentry (optional, guarded by env vars)
- **Deployment:** Netlify (configured in `netlify.toml`)

---

## Repository Structure

```
tanstack-template/
├── convex/                  # Convex backend (optional persistence)
│   ├── _generated/          # Auto-generated types — DO NOT EDIT
│   ├── conversations.ts     # Convex queries/mutations
│   ├── schema.ts            # Database schema
│   └── tsconfig.json
├── public/                  # Static assets
├── src/
│   ├── components/          # UI components (one per file, PascalCase)
│   │   ├── ChatInput.tsx
│   │   ├── ChatMessage.tsx
│   │   ├── LoadingIndicator.tsx
│   │   ├── SettingsDialog.tsx
│   │   ├── Sidebar.tsx
│   │   └── WelcomeScreen.tsx
│   ├── routes/              # File-based routes (TanStack Router)
│   │   ├── __root.tsx       # Root layout (ConvexClientProvider + Outlet)
│   │   └── index.tsx        # Home route "/"
│   ├── store/               # TanStack Store state management
│   │   ├── store.ts         # Store definition, actions, selectors
│   │   └── hooks.ts         # useAppState, useConversations hooks
│   ├── utils/
│   │   └── ai.ts            # Server function: genAIResponse (streaming)
│   ├── api.ts               # TanStack Start API handler entry
│   ├── client.tsx           # Client hydration (Sentry optional)
│   ├── convex.tsx           # ConvexClientProvider wrapper
│   ├── router.tsx           # Router creation
│   ├── routeTree.gen.ts     # AUTO-GENERATED — DO NOT EDIT
│   ├── sentry.ts            # Sentry init helper
│   ├── ssr.tsx              # SSR entry (Sentry optional)
│   └── styles.css           # Global styles + Tailwind + highlight.js theme
├── app.config.ts            # TanStack React Start config (Netlify preset)
├── vite.config.js           # Vite plugins (Sentry conditional)
├── postcss.config.ts        # Tailwind v4 PostCSS
├── tsconfig.json            # TypeScript (strict, ESNext, bundler mode)
├── netlify.toml             # Netlify deployment + env var template
└── .env.example             # Environment variables reference
```

---

## Development Commands

```bash
npm run dev      # Start development server (HMR via Vinxi)
npm run build    # Production build
npm run serve    # Preview production build locally
npm start        # Start production server
```

There is no linter, formatter, or test runner configured. TypeScript strict mode is the primary code quality check.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_ANTHROPIC_API_KEY` | **Yes** | Anthropic API key for Claude |
| `VITE_CONVEX_URL` | No | Convex deployment URL (enables persistence) |
| `VITE_SENTRY_DSN` | No | Sentry DSN (enables error tracking) |
| `SENTRY_AUTH_TOKEN` | No | Build-time Sentry token (enables source maps) |

Copy `.env.example` to `.env` and fill in `VITE_ANTHROPIC_API_KEY` at minimum. The app degrades gracefully when optional services are absent.

---

## Architecture & Key Patterns

### Routing

TanStack Router uses file-based routing. Route files live in `src/routes/`. The route tree (`src/routeTree.gen.ts`) is **auto-generated** — never edit it manually. Add routes by creating files in `src/routes/`.

- `__root.tsx` — Root layout wrapping the full app
- `index.tsx` — Main chat UI at `/`

### Server Functions (API layer)

API logic is colocated with the frontend using TanStack Start server functions (`createServerFn`). Example pattern:

```typescript
// src/utils/ai.ts
export const genAIResponse = createServerFn({ method: 'GET', response: 'raw' })
  .validator((data: unknown) => { /* validate input */ return data as InputType })
  .handler(async ({ data }) => {
    // runs server-side only
    const stream = client.messages.stream({ ... })
    return new Response(stream.toReadableStream(), { ... })
  })
```

The client reads the stream with `ReadableStream` / `TextDecoder`. This is the only API integration point — do not add a separate Express/Next API layer.

### State Management

State lives in `src/store/store.ts` using TanStack Store. Two custom hooks wrap it:

- **`useAppState()`** — Full store access (prompts, UI state). Use in settings/prompt management.
- **`useConversations()`** — Hybrid local+Convex sync. Use for all conversation/message operations.

`useConversations()` writes to local state immediately, then syncs to Convex if available. Always use these hooks — never import the store directly in components.

**Store shape:**
```typescript
{
  prompts: Prompt[]              // Custom system prompts
  conversations: Conversation[]  // All conversations (local cache)
  currentConversationId: string | null
  isLoading: boolean
}
```

### Convex Integration (Optional)

Convex provides optional server-side persistence. It's configured in `convex/`. The app checks for `VITE_CONVEX_URL` and uses `useQuery`/`useMutation` from `convex/react` when available. All Convex operations are wrapped in try-catch so the app works without it.

Schema: `conversations` table with `title: string` and `messages: array`.

### AI Streaming

The `genAIResponse` server function streams from Anthropic's API:
1. Server: `client.messages.stream()` → `response.toReadableStream()`
2. Client: Reads stream chunk-by-chunk, appends to message state in real time
3. Model: `claude-3-5-sonnet-20241022`, max 4096 tokens, 30s timeout

System prompts: A default markdown-focused prompt is always included. The active custom prompt (from settings) is prepended to it.

### Styling

Tailwind CSS v4 via PostCSS. All styles in `src/styles.css`. The color scheme is dark mode with orange/red gradient accents. Code highlighting uses the GitHub Dark theme from `highlight.js`.

No CSS modules or styled-components — use Tailwind utility classes directly on JSX elements.

---

## Code Conventions

### Naming
- **Components:** PascalCase (`ChatMessage.tsx`, `SettingsDialog.tsx`)
- **Utility files:** camelCase (`ai.ts`, `store.ts`)
- **Hooks:** `use*` prefix (`useAppState`, `useConversations`)
- **Store selectors:** `get*` prefix (`getActivePrompt`, `getCurrentConversation`)
- **Route files:** lowercase (`index.tsx`, `__root.tsx`)

### Component Structure
- One component per file
- Functional components with hooks only
- `useCallback` for event handlers passed as props
- `useMemo` for derived arrays/objects used in render
- Local `useState` only for pure UI state (modals, input values)

### TypeScript
- Strict mode is enabled — no `any`, no unused variables/parameters
- Define interfaces/types at the top of the file or in the relevant module
- Target: `ES2022`, module: `ESNext`, bundler resolution

### Error Handling
- Try-catch in all async functions
- Show user-facing error messages in the UI (not just console)
- Graceful degradation for optional services (Convex, Sentry)
- Specific error messages for rate limits, auth failures, network errors

### Do Not Edit (Auto-generated)
- `src/routeTree.gen.ts` — Regenerated by TanStack Router on `npm run dev`
- `convex/_generated/` — Regenerated by Convex CLI

---

## Deployment

The app deploys to **Netlify** with SSR via the Vinxi Netlify preset (`app.config.ts`). `netlify.toml` templates the `VITE_ANTHROPIC_API_KEY` environment variable.

```bash
npm run build   # Outputs to .netlify/
```

For other platforms, change `server.preset` in `app.config.ts` (supports Vercel, Cloudflare Workers, Node, etc.).

---

## Common Tasks

### Add a new route
Create `src/routes/my-page.tsx` with a `Route` export. The route tree regenerates automatically.

### Add a new component
Create `src/components/MyComponent.tsx`. Import directly — no barrel index needed.

### Add a new store action
Add the action function to `src/store/store.ts` alongside the existing actions, then expose it via the appropriate hook in `src/store/hooks.ts`.

### Change the AI model or parameters
Edit `src/utils/ai.ts` — the `handler` in `genAIResponse`. Parameters are `model`, `max_tokens`, and `system`.

### Add a new Convex query/mutation
Add a function to `convex/conversations.ts`, update `convex/schema.ts` if schema changes, then use via `useQuery`/`useMutation` in hooks.
