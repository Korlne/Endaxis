# Endaxis Copilot Instructions

## Project Overview
Endaxis is a Vue 3 web application for creating visual timeline editors for two games: Arknights Endfield and Zenless Zone Zero (ZZZ). It features drag-and-drop timeline editing with real-time simulation of game mechanics.

## Architecture Principles
- **Strict Separation**: Pure TypeScript simulation engines completely isolated from Vue view layer
- **Event-Driven**: All state changes flow through events and dedicated handlers (single-direction data flow)
- **Type Isolation**: Game modes (Endaxis vs ZZZ) have completely separate type systems
- **Component Reusability**: Timeline UI components are generic and adapted via interfaces
- **Strategy Pattern**: Data persistence uses pluggable strategies (fetch/save/file formats)

## Key Directories & Files
- `src/simulation/` - Endaxis game mechanics engine (TypeScript)
- `src/simulation_zzz/` - ZZZ game mechanics engine (TypeScript)
- `src/components/` - Reusable Vue components (TimelineGrid, ActionItem, ConnectionPath)
- `src/views/` - Page components (TimelineEditor.vue, ZZZEditor.vue)
- `src/stores/timelineStore.js` - Pinia store for timeline state
- `src/api/` - Data persistence strategies
- `public/gamedata.json` - Game data definitions

## Development Workflow
```bash
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run type-check   # TypeScript checking
npm run test         # Run Vitest tests
```

## Coding Patterns

### Vue Components
- Use Composition API (`<script setup lang="ts">`)
- Import types explicitly: `import type { ZZZAction } from '@/simulation_zzz/types'`
- Reactive data with `ref()` and `computed()`
- Event emission: `emit('updateActionData', { id, field, value })`

### Simulation Engine
- Event-driven with priority queues
- Calculation pipelines for stat modifications
- Handler pattern for game events
- Snapshot testing with `__snapshots__/` directories

### Data Flow
- UI → Compiler → Simulation Engine → Results
- Actions compile to ResolvedTimeline with connections
- Real-time projection of SP, stagger, and damage series

### File Operations
- Strategy pattern: `fetchStrategy.js`, `saveStrategy.js`, `zzzFileStrategy.js`
- Gzip compression: `gzipUtils.js`
- Metadata embedding in PNGs: `pngUtils.js`

## Game Mode Integration
When adding features:
1. Define types in respective `simulation_*/types.ts`
2. Implement compiler in `simulation_*/compiler/`
3. Create event handlers in `simulation_*/events/`
4. Adapt UI components via interfaces (don't modify core components)
5. Add data persistence strategy if needed

## Common Patterns
- Timeline actions have `startTime`, `duration`, `hitTicks`
- Connections between actions via `ActionLinkPorts.vue`
- Drag connections with `useDragConnection.js`
- Color coding by character: `getCharacterColor(name)`
- Time precision with `snapMs()` from `precision.js`

## Testing
- Unit tests in `*.test.ts` files
- Snapshot tests for simulation results
- Component tests with Vue Test Utils

## Deployment
- Built with Vite to static files
- Served from `/` base path
- Game data in `public/` directory
- i18n locales in `src/i18n/locales/`</content>
<parameter name="filePath">c:\Users\59275\Desktop\Endaxis-main\.github\copilot-instructions.md