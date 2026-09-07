# Ai-Vidya – AI Assessment Creator

A production-grade AI-powered assessment and question-paper generator. Monorepo with a **Next.js** frontend and **Node.js + Express** backend, **Clerk** auth (teacher / student roles).

**Contents:** [Architecture](#architecture-overview) · [Tech stack](#tech-stack) · [Security](#security) · [Setup](#setup) · [Clerk setup](#clerk-setup) · [Scripts](#scripts) · [Production](#production)

## Architecture Overview

```
┌─────────────┐     REST API      ┌─────────────┐     BullMQ      ┌─────────-─┐
│   Frontend  │ ─────────────▶    │   Backend   │ ──────────────▶ │  Worker   │
│  (Next.js)  │                   │  (Express)  │                 │  (BullMQ) │
│             │ ◀──── WS ──────   │             │                 │           │
└─────────────┘   Socket.io       └─────��┬──────┘                 └─────┬─────┘
                                         │                              │
                                    ┌────▼────┐                    ┌─────▼─────┐
                                    │  Redis  │                    │  OpenAI / │
                                    │ (Cache) │                    │ Anthropic │
                                    └─────────┘                    │ Gemini /  │
                                    ┌─────────┐                    │ Groq /    │
                                    │ MongoDB │                    │ Ollama    │
                                    │  (Data) │                    └───────────┘
                                    └─────────┘
```

**Flow:**

1. User fills the form → `POST /api/assignments`
2. Backend creates a MongoDB document and queues a BullMQ job
3. Worker picks up the job and calls the configured AI provider (Gemini, Groq, Ollama, OpenAI, or Anthropic)
4. Worker parses and validates LLM JSON → saves to MongoDB
5. Socket.io pushes progress events to the frontend in real time
6. Frontend renders the generated paper and supports PDF export

## Tech Stack

### Frontend

- **Next.js** (App Router) + TypeScript
- **Clerk** for authentication and role-based routing
- **Zustand** for client state
- **Socket.io-client** for real-time job updates
- Tailwind CSS, Framer Motion
- React Hook Form + Zod
- `@react-pdf/renderer` for PDF export
- Lucide React for icons

### Backend

- **Node.js + Express** + TypeScript
- **MongoDB** with Mongoose
- **Redis** (ioredis) for caching and job state
- **BullMQ** for background job queues
- **Socket.io** for real-time events
- **Clerk** session verification on API routes
- Multer for file uploads, pdf-parse for PDF text extraction
- AI SDKs via `AI_PROVIDER` env (Gemini / Groq / Ollama / OpenAI / Anthropic)
- Zod for request validation

### Shared

- `@Ai-Vidya/shared` — TypeScript types shared across frontend and backend via workspace path aliases

### Infrastructure

- **Docker Compose** for local MongoDB + Redis only (`docker-compose.yml`)
- Production: managed MongoDB (e.g. Atlas) and Redis (e.g. Redis Cloud)
- Optional **Render** blueprint: `render.yaml` for the API service

## Security

- **Do not commit** `.env`, `.env.local`, `.env.*` (except `.env.example`), API keys, or database URLs with credentials.
- **Use a local `.env`** at the repo root (`cp .env.example .env`). Root `.gitignore` ignores env files; **`.env.example` is the only committed template** and must stay placeholder-only.
- **Production:** set variables in your host dashboard (Vercel, Railway, Render, etc.), not in git.
- **Clerk:** mirror keys from `.env.example` on frontend and API. Session token must expose metadata (see [Clerk setup](#clerk-setup)).
- If a real key was ever pushed, **rotate it** and consider scrubbing git history (`git filter-repo`, BFG).

## Setup

### Prerequisites

- Node.js 20+
- Docker + Docker Compose

### Installation

```bash
cp .env.example .env
# Fill in secrets locally only — never commit .env

docker compose up -d
npm install
npm run dev
```

| Service  | URL                   |
|----------|------------------------|
| Frontend | http://localhost:3000 |
| API      | http://localhost:4000 |
| Health   | `GET /health`         |

**Frontend env:** copy `NEXT_PUBLIC_*` and Clerk keys into `apps/frontend/.env.local` (or use root `.env`). `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` are the **API origin only** (no `/api` suffix).

**`ERR_CONNECTION_REFUSED` on port 4000:** API not running or failed boot. Check the backend process for MongoDB / Redis / Clerk errors. Optionally set `NEXT_PUBLIC_API_URL=http://127.0.0.1:4000`

Or run services separately:

```bash
npm run dev:backend
npm run dev:frontend
```

### Clerk setup

1. Create an application at [Clerk Dashboard](https://dashboard.clerk.com).
2. Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
3. After sign-up, `/onboarding` sets `publicMetadata.role`, or configure roles in the dashboard.
4. **Session token (required):** Configure → Sessions → Customize session token:

   ```json
   { "metadata": "{{user.public_metadata}}" }}
   ```

## Scripts

Run from the **repo root**:

| Command | Description |
|---------|-------------|
| `npm run dev` | API + frontend (concurrently) |
| `npm run dev:backend` | Express API only |
| `npm run dev:frontend` | Next.js only |
| `npm run build` | Build backend, then frontend |
| `npm run build:backend` | Compile API (`tsc`) |
| `npm run build:frontend` | Production Next.js build |
| `npm run start:backend` | Run compiled API |
| `npm run lint` | ESLint (frontend) |
| `npm run install:all` | `npm install` (workspaces) |

## Production

```bash
npm run build
cd apps/backend && npm start
cd apps/frontend && npm start
```

Ensure production env vars are set on the server (or via the host UI), not committed in `.env`.

### Hosted deployment

**Backend** (Railway, Render, Fly.io, etc.)

- `PORT`, `MONGODB_URI`, `REDIS_URL`, `FRONTEND_URL` (frontend origin, no trailing slash), Clerk keys, `JWT_SECRET`, AI keys
- `FRONTEND_URL` drives CORS and Socket.io origins
- Health: `GET /health`
- **Render:** `render.yaml` — build `npm ci && npm run build:backend`, start `cd apps/backend && npm start`
- Legacy assignments may lack `teacherId` / `studentIds`; seed fresh data or backfill before relying on auth-scoped APIs

**Frontend** (e.g. Vercel)

- `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` = public API origin (no `/api` suffix)

## Project Structure

```
Ai-Vidya/
├── apps/
│   ├── frontend/                 # Next.js (App Router) + TypeScript
│   │   ├── public/
│   │   │   └── Ai-Vidya-logo.svg
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (public)/     # sign-in, sign-up
│   │       │   ├── (teacher)/    # home, classes, assignments, analytics, create, settings, …
│   │       │   ├── (student)/      # student home, assignments, join, analytics
│   │       │   ├── onboarding/
│   │       │   ├── layout.tsx
│   │       │   └── globals.css
│   │       ├── components/
│   │       │   ├── layout/       # AppShell, Sidebar, TopBar, MobileTabBar, TeacherMobileHeader
│   │       │   ├── assignment/ # AssignmentForm, FileUpload, …
│   │       │   ├── paper/        # PaperView, PDFExport, QuestionCard, …
│   │       │   ├── notifications/
│   │       │   ├── ui/           # AppHeader, shadcn-style primitives
│   │       │   └── shared/       # LoadingSpinner, ErrorBoundary, …
│   │       ├── features/
│   │       │   └── teacher/      # TeacherHomeDashboard, …
│   │       ├── hooks/
│   │       ├── lib/
│   │       │   ├── api/          # assignments, analytics, classes, http client
│   │       │   ├── clerk/        # roleFromClaims
│   │       │   ├── socket/       # useSocket
│   │       │   │   ├── store/        # Zustand
│   │       │   │   └── utils/
│   │       │   └── globals.css
│   │       └── middleware.ts     # Clerk + role gates
│   └── backend/                  # Node.js + Express + TypeScript
│       └── src/
│           ├── config/           # db, redis, env
│           ├── models/           # Assignment, TeacherClass, User, …
│           ├── middleware/       # upload, authContext (Clerk)
│           ├── queues/           # BullMQ queue & worker
│           ├── services/         # aiService, pdfService
│           ├── routes/           # assignments, analytics, classes, studentAnalytics
│           ├── socket/           # Socket.io
│           ├── utils/
│           └── types/
├── packages/
│   └── shared/                   # @Ai-Vidya/shared types
├── docker-compose.yml
├── .env.example
├── render.yaml
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/assignments` | Create assignment (multipart) |
| GET | `/api/assignments` | List assignments (paginated, role-scoped) |
| GET | `/api/assignments/:id` | Get one assignment |
| POST | `/api/assignments/:id/regenerate` | Regenerate (teacher) |
| DELETE | `/api/assignments/:id` | Delete (teacher) |
| GET | `/api/analytics/summary` | Teacher analytics summary |
| GET | `/api/analytics/student/summary` | Student analytics summary |
| GET | `/api/classes` | List teacher classes |
| POST | `/api/classes` | Create class |
| GET | `/api/classes/:id` | Get class |
| PATCH | `/api/classes/:id` | Update class |
| DELETE | `/api/classes/:id` | Delete class |
| POST | `/api/classes/join` | Student join by code |
| GET | `/health` | Health check |

Authenticated routes expect a valid Clerk session unless noted.

## WebSocket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `subscribe:assignment` | Client → Server | `assignmentId` |
| `job:started` | Server → Client | `{ type, assignmentId, message }` |
| `job:progress` | Server → Client | `{ type, assignmentId, progress, message }` |
| `job:completed` | Server → Client | `{ type, assignmentId, progress, result }` |
| `job:failed` | Server → Client | `{ type, assignmentId, error }` |

## AI Providers

| Provider | Cost | Setup |
|----------|------|--------|
| **gemini** (default) | Free tier on Google AI Studio | [API key](https://aistudio.google.com/apikey) → `AI_PROVIDER=gemini`, `GEMINI_API_KEY` |
| **groq** | Free tier | [API key](https://console.groq.com/keys) → `AI_PROVIDER=groq`, `GROQ_API_KEY` |
| **ollama** | Local | [ollama.com](https://ollama.com), `ollama pull llama3.2`, `AI_PROVIDER=ollama` |
| **openai** / **anthropic** | Paid | Optional |

Example:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

Use a model with non-zero quota in AI Studio (often `gemini-2.5-flash` on free tiers). Restart the backend after changing `.env`.

## Design Decisions

- **BullMQ:** LLM calls take 10–30s. BullMQ provides retries (exponential backoff) and avoids HTTP timeouts while processing jobs concurrently.
- **Zustand over Redux:** Less boilerplate for this app’s state size.
- **Structured JSON prompts:** Questions grouped by type into sections for deterministic parsing and validation.
- **@react-pdf/renderer:** Consistent PDFs across platforms vs browser print.
- **Redis caching:** Assignment results cached (~1 hour); invalidated on regenerate/delete.
- **Socket.io rooms:** Per-assignment rooms target progress events to watching clients only.
- **Shared types:** `@Ai-Vidya/shared` keeps frontend and backend interfaces aligned.
- **Clerk + JWT metadata:** Edge middleware reads `role` from the session token to gate teacher vs student routes without a DB hit on every navigation.

## License

Private / assignment use — add a license file if you open-source this project.
