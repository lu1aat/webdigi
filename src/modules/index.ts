import type { Module } from '../core/module'

/**
 * Auto-discovers src/modules/<id>/index.ts (default export: Module).
 * To disable a module, delete its folder or rename it to start with "_".
 */
const found = import.meta.glob<{ default: Module }>(['./*/index.ts', '!./_*/index.ts'], { eager: true })

export const modules: Module[] = Object.values(found).map((m) => m.default)
