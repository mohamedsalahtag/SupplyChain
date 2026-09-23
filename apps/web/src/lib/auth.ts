import { trpc } from './trpc';

/** The signed-in user (null when signed out, undefined while loading). */
export function useMe() {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  return { me: me.data, loading: me.isPending };
}

/** can('materials.open') → true when the user holds that permission. The server checks again. */
export function useCan() {
  const { me } = useMe();
  const granted = new Set(me?.permissions ?? []);
  return (key: string) => !!me && (me.isAdmin || granted.has(key));
}
