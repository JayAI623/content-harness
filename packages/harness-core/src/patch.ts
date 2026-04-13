import type { Delta, StatePatch } from "./types.js";

export function applyPatch<S>(state: S, patch: StatePatch): S {
  if (patch.path.length === 0) {
    return patch.value as S;
  }
  const copy: any = Array.isArray(state) ? [...(state as any)] : { ...(state as any) };
  let cursor: any = copy;
  for (let i = 0; i < patch.path.length - 1; i++) {
    const k = patch.path[i]!;
    cursor[k] = Array.isArray(cursor[k]) ? [...cursor[k]] : { ...(cursor[k] ?? {}) };
    cursor = cursor[k];
  }
  const last = patch.path[patch.path.length - 1]!;
  switch (patch.op) {
    case "set":
      cursor[last] = patch.value;
      break;
    case "append": {
      const arr = Array.isArray(cursor[last]) ? [...cursor[last]] : [];
      arr.push(patch.value);
      cursor[last] = arr;
      break;
    }
    case "merge":
      cursor[last] = { ...(cursor[last] ?? {}), ...(patch.value as object) };
      break;
  }
  return copy as S;
}

export function applyDelta<S>(state: S, delta: Delta<S>): S {
  let next = state;
  for (const p of delta.patches) next = applyPatch(next, p);
  return next;
}
