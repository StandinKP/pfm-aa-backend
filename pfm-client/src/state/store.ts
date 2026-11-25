/** Minimal typed store: one state object, a pure reducer, subscribers. No framework. */
export interface Store<S, A> {
  get(): S;
  dispatch(a: A): void;
  subscribe(f: (s: S) => void): () => void;
}

export function createStore<S, A>(reducer: (s: S, a: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const subs = new Set<(s: S) => void>();
  return {
    get: () => state,
    dispatch(a) {
      const next = reducer(state, a);
      if (next === state) return;
      state = next;
      for (const f of [...subs]) f(state);
    },
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
