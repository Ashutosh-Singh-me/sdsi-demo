# PROMPTS.md — AI Collaboration Effectiveness

## Summary

This project was built with Claude Code serving as the primary development agent. The AI was given the problem statement (PS4: Inventory Reservation System) and asked to design and implement a full-stack solution using React + Express + SQLite.

## Approach

1. **Exploration phase**: Discovered the repo scaffold (README, agent-template/, usecases/) and confirmed the `submissions/ashutosh.s1/` directory was empty — greenfield build.

2. **Plan-first**: Created a detailed `Plan.md` covering database schema, API design, concurrency strategy (WAL + IMMEDIATE transactions), TTL expiry (lazy cleanup), frontend component tree, and implementation order.

3. **MVP mindset**: Deliberately kept it simple — no React Router, no Redux/Context boilerplate, no unnecessary abstractions. Plain `useState` + `useEffect` in App.jsx, with `fetch`-based API calls. The goal was a working system in under 15 minutes of build time.

4. **Concurrency-first design**: The hardest problem in flash sales is preventing overselling. SQLite's `BEGIN IMMEDIATE` transactions ensure that stock check and reservation insertion are atomic — no two users can reserve the last item simultaneously.

5. **Lazy TTL cleanup**: Rather than building a background job or cron, every operation that reads reservations first expires stale ones. This is simpler, more robust (survives restarts), and correct.

## Key Decisions

- **better-sqlite3** over sqlite3: Synchronous API + proper transaction support, critical for atomic reserve operations
- **UUID v4** for reservation IDs: No auto-increment, no guessable IDs
- **Stock computed, not stored**: `available = total_stock - SUM(active) - SUM(confirmed)` — single source of truth
- **User ID on confirm/cancel**: Both `reservationId` and `userId` required — prevents confirming another user's reservation
- **Vite proxy**: Frontend dev server proxies `/api` to backend — no CORS issues in dev

## Prompts Used

1. Initial: "Create a plan for the Inventory Reservation System" — produced Plan.md
2. Follow-up: User requested MVP speed — all code written in a single session
3. Implementation: Backend (db, services, routes, server entry), then frontend (API client, components, CSS)