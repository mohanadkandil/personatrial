# personatrial

A local-first frontend concept for Persona onboarding. Built with Next.js App Router, React, TypeScript, and Canvas UI's Particle Object effect.

## Try it

```sh
npm install
npm run dev -- --port 3100
```

Open http://localhost:3100 for the landing page or http://localhost:3100/chat for the conversation. Production validation: `npm run build`. Browser checks: `npm run test:e2e` (requires Google Chrome, or set the Playwright project to its installed Chromium).

## Implemented

- Responsive black landing page with interactive particles, reduced-motion support, and a visual fallback.
- Phone-sized conversation with editable assistant name, scripted chat paths, and message persistence in this browser.
- Voice preview with a browser-synthesized greeting, playback control, timer, hangup, and return to the same chat. Refreshing an active preview restores chat without a ghost call.
- Explicitly fictional sample inbox and reply draft. No email is sent.
- Accessible labeled controls, native modal dialogs, keyboard submission, and confirmed session reset.

## Scope

This is a **frontend preview**, not a connected AI agent. Replies are scripted in `src/lib/demo.ts`. The call does not record the microphone or use a realtime model. Gmail OAuth, genuine inbox search, server-side memory, durable tasks, fault injection, and hosted deployment remain backend work. Browser local storage is not a durability guarantee across devices or storage removal.

The user asked to review locally before any GitHub push. The remote is configured, but nothing has been pushed or deployed.

## Design and implementation

- `src/app/page.tsx`: landing page.
- `src/components/chat-experience.tsx`: interactive chat, call, and settings.
- `src/lib/demo.ts`: replaceable scripted conversation adapter and state validation.
- `src/components/particle-scene.tsx`: lazy-loaded particle scene and fallback.
- [Backend proposal](docs/architecture.md): agent responsibilities, state, jobs, delivery, infrastructure, scaling.
- [Recovery acceptance plan](docs/recovery-tests.md): future integration requirements, not a report of passing implemented behavior.

## Canvas UI attribution

Particle Object React/vanilla implementations and rectangle cache are sourced from [Canvas UI](https://github.com/DavidHDev/canvas-ui), inspected at commit `44de3787b77d78477a7c03a4c81a7d5ea317cdbc`. Component docs: https://canvasui.dev/docs/components/particle-object. Copyright David Haz, 2026; source license preserved in `src/components/canvasui/LICENSE.md`. Used within this application under its MIT + Commons Clause terms. The sphere SVG is original to this project.

No API keys or paid services are required for this frontend.
