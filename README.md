# Modpack Studio

Local web app that maintains the LMP modpack (ATM10-based). Spec and plans live in
`C:\Users\compt\Server\docs\plans\` (`2026-10-29-modpack-studio-conception.md`, `...-phase0-1-plan.md`).

Runtime target: Node 24 LTS (`engines`). Developed on Node 25.4.0 here: use only features present in 24.

## Pinned versions (latest stable verified with `npm view` on 2026-10-29)

fastify 5.12.7, zod 4.6.7, better-sqlite3 13.0.3, drizzle-orm 0.45.4, drizzle-kit 0.31.11, piscina 5.3.2,
yauzl 3.4.0, yazl 3.3.1, @fastify/cookie 11.1.5, @fastify/rate-limit 11.2.1, typescript 7.0.2, vitest 5.0.5, tsx 4.23.15.
Web (Task 18): react 19.3.1, vite 8.3.5, @vitejs/plugin-react 6.1.2, tailwindcss 4.3.3, @tanstack/react-query 5.105.0,
@tanstack/react-table 9.3.1, @tanstack/react-virtual 3.14.23, @playwright/test 1.64.1, @testing-library/react 16.3.3, jsdom 30.1.3.

## Commands

`npm test` (Vitest), `npm run typecheck`, `npm run start`.
