import { afterEach, expect, it, vi } from "vitest";
import { EditorMediaResolver } from "./uploaded-media";

const identity = vi.hoisted(() => ({ generation: 0 }));
vi.mock("./identity", () => ({ identityGeneration: () => identity.generation, onIdentityChange: () => () => {} }));
vi.mock("./api-client", () => ({ api: vi.fn() }));
const source = "/storage/owned/uploads/wiki/space/00000000-0000-4000-8000-000000000001.gif";
afterEach(() => { identity.generation = 0; });

it("a construction-time request stays inert until committed and resolves once", async () => {
  const owner = { resolve: vi.fn().mockResolvedValue("blob:owned") }, resolver = new EditorMediaResolver(owner);
  const pending = resolver.resolve(source); await Promise.resolve(); expect(owner.resolve).not.toHaveBeenCalled();
  resolver.commit(); expect(owner.resolve).not.toHaveBeenCalled(); expect(await pending).toBe("blob:owned"); expect(owner.resolve).toHaveBeenCalledExactlyOnceWith(source); resolver.deactivate();
});
it("committed StrictMode setup-cleanup-setup retains only never-dispatched same-identity work", async () => {
  const owner = { resolve: vi.fn().mockResolvedValue("blob:second-commit") }, resolver = new EditorMediaResolver(owner);
  const pending = resolver.resolve(source); resolver.commit(); resolver.deactivate(); resolver.commit();
  expect(await pending).toBe("blob:second-commit"); expect(owner.resolve).toHaveBeenCalledTimes(1); resolver.deactivate();
});
it("actual cleanup before commit settles without IO and generation changes cannot adopt work", async () => {
  const owner = { resolve: vi.fn().mockResolvedValue("blob:forbidden") }, resolver = new EditorMediaResolver(owner);
  const pending = resolver.resolve(source); resolver.deactivate(); expect(await pending).toBe("about:blank"); expect(owner.resolve).not.toHaveBeenCalled();
  const stale = resolver.resolve(source); identity.generation++; resolver.commit(); expect(await stale).toBe("about:blank"); expect(owner.resolve).not.toHaveBeenCalled(); resolver.deactivate();
});
it("retired in-flight work cannot publish over a later commit or reject the SDK promise", async () => {
  let finish!: (url: string) => void;
  const owner = { resolve: vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; })).mockResolvedValue("blob:current") }, resolver = new EditorMediaResolver(owner);
  resolver.commit(); const old = resolver.resolve(source); await vi.waitFor(() => expect(owner.resolve).toHaveBeenCalledTimes(1)); resolver.deactivate(); expect(await old).toBe("about:blank"); resolver.commit();
  expect(await resolver.resolve(source)).toBe("blob:current"); finish("blob:old"); await Promise.resolve();
  owner.resolve.mockRejectedValueOnce(Error("visible refusal already reported by owner")); expect(await resolver.resolve(source)).toBe("about:blank"); resolver.deactivate();
});
