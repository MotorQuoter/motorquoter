// Minimal Node ESM loader so standalone scripts can import app modules that use Next.js conventions
// the plain-Node resolver doesn't handle: the "@/" path alias (jsconfig paths) and extensionless
// imports (Next/webpack allow `@/lib/foo`; Node requires `foo.js`). Also stubs `next/server`, whose
// subpath export doesn't resolve outside the Next bundler. Register with:
//   node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs
// Dev tooling only — never part of the app runtime. (Cowork §7/§8 replay harness.)
import { pathToFileURL, fileURLToPath } from 'url';
import { resolve as pathResolve, dirname } from 'path';
import { existsSync, statSync } from 'fs';

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEXT_SERVER_STUB = pathToFileURL(pathResolve(ROOT, 'scripts', 'lib', 'next-server-stub.mjs')).href;

// Given a filesystem base path with no (or an implicit) extension, find the real file the way a
// bundler would: exact file, then common JS extensions, then an index file for a directory.
const EXTS = ['.js', '.mjs', '.cjs', '.json'];
function probeExts(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const e of EXTS) if (existsSync(pathResolve(base, 'index' + e))) return pathResolve(base, 'index' + e);
  }
  return null;
}

export async function resolve(specifier, context, next) {
  // The replay harness never calls the GET handler, so NextResponse is unused at runtime.
  if (specifier === 'next/server') return next(NEXT_SERVER_STUB, context);

  // Resolve "@/x" (alias) and extensionless relative imports ourselves; bare packages pass through.
  let base = null;
  if (specifier.startsWith('@/')) {
    base = pathResolve(ROOT, specifier.slice(2));
  } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    base = pathResolve(dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base) {
    const hit = probeExts(base);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return next(specifier, context);
}
