import {
  MutationCache,
  notifyManager,
  QueryClient,
  type MutationObserver,
  type Mutation,
  type MutationOptions,
  type MutationState,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { IdentityChangedError, isIdentityChangedError } from "./api-error";
import { identityGeneration, onIdentityChange } from "./identity";

// A mutation belongs to the identity that started it. After the identity
// changes, its request is aborted (see api-client) and its own callbacks are
// skipped: an optimistic rollback, a cache write, a navigation or a toast for
// the previous account must not reach the next one. A mutation that has not
// sent its request yet (paused offline, or queued in a scope) fails instead
// of running as the new identity.
function withinIdentity<TData, TError, TVariables, TOnMutateResult>(
  options: MutationOptions<TData, TError, TVariables, TOnMutateResult>,
  generation: number,
): MutationOptions<TData, TError, TVariables, TOnMutateResult> {
  const current = () => identityGeneration() === generation;
  const guard = <A extends unknown[], R>(
    callback: ((...args: A) => R) | undefined,
  ) => callback && ((...args: A) => (current() ? callback(...args) : undefined));
  const { mutationFn } = options;
  return {
    ...options,
    mutationFn:
      mutationFn &&
      ((variables, context) =>
        current()
          ? mutationFn(variables, context)
          : Promise.reject(new IdentityChangedError())),
    // Skipped optimistic updates leave no context; the request is rejected.
    onMutate: guard(options.onMutate) as typeof options.onMutate,
    onSuccess: guard(options.onSuccess),
    onError: guard(options.onError),
    onSettled: guard(options.onSettled),
  };
}

// The observers (useMutation hooks) attached to each mutation. Callbacks passed
// to `mutate(variables, callbacks)` run through the observer rather than the
// mutation's options, so on an identity change the observers of every pending
// mutation are reset: they detach and report idle.
type AnyMutationObserver = MutationObserver<any, any, any, any>;
const mutationObservers = new WeakMap<object, Set<AnyMutationObserver>>();

class IdentityScopedMutationCache extends MutationCache {
  build<TData, TError, TVariables, TOnMutateResult>(
    client: QueryClient,
    options: MutationOptions<TData, TError, TVariables, TOnMutateResult>,
    state?: MutationState<TData, TError, TVariables, TOnMutateResult>,
  ): Mutation<TData, TError, TVariables, TOnMutateResult> {
    const mutation = super.build(client, options, state);
    const generation = identityGeneration();
    // useMutation re-applies its (unguarded) options to a pending mutation on
    // every render, so the guard is applied to those as well.
    const setOptions = mutation.setOptions.bind(mutation);
    mutation.setOptions = (next) => setOptions(withinIdentity(next, generation));
    mutation.setOptions(mutation.options);
    const observers = new Set<AnyMutationObserver>();
    mutationObservers.set(mutation, observers);
    const addObserver = mutation.addObserver.bind(mutation);
    const removeObserver = mutation.removeObserver.bind(mutation);
    mutation.addObserver = (observer) => {
      observers.add(observer);
      addObserver(observer);
    };
    mutation.removeObserver = (observer) => {
      observers.delete(observer);
      removeObserver(observer);
    };
    return mutation;
  }
}

export const queryClient = new QueryClient({
  mutationCache: new IdentityScopedMutationCache(),
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      // Keep one failed API operation to one attempt at both client layers.
      // Polling, explicit refetches and refetch-on-focus remain separate events.
      retry: false,
      refetchOnWindowFocus: true,
    },
    mutations: {
      onError: (error) => {
        if (isIdentityChangedError(error)) return;
        toast.error(error.message || "Something went wrong");
      },
    },
  },
});

// Every cached query and mutation belongs to the previous identity. Removing
// a query also cancels its fetch, so a late response is discarded. Removal
// alone does not update components still showing a query, so each one is
// also emptied: nothing mounted keeps displaying the previous account's data.
onIdentityChange(() => {
  const queries = queryClient.getQueryCache().getAll();
  for (const mutation of queryClient.getMutationCache().getAll()) {
    for (const observer of [...(mutationObservers.get(mutation) ?? [])])
      observer.reset();
  }
  queryClient.clear();
  notifyManager.batch(() => {
    for (const query of queries) query.reset();
  });
});
