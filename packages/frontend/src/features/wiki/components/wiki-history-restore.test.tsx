import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiPageView } from "@/features/wiki/components/wiki-page-view";
import { useAuthStore } from "@/stores/auth-store";
import { queryKeys } from "@/lib/query-keys";

const { http, notices } = vi.hoisted(() => ({
  http: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  notices: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => undefined }));
// Actual page, panel, HTTP mutation hooks, React Query, autosave and page-lock
// hooks run. Ordinary editor input is a carrier, not BlockNote/browser proof.
vi.mock("@/features/wiki/components/lazy-wiki-editor", async () => {
  const React = await import("react");
  const WikiEditor = ({ initialContent, recoveredContent, onChange, readOnly }: any) => {
    const [value, setValue] = React.useState(JSON.stringify(recoveredContent ?? initialContent));
    React.useEffect(() => { setValue(JSON.stringify(recoveredContent ?? initialContent)); }, [recoveredContent, initialContent]);
    return <textarea aria-label="History body carrier" value={value} disabled={readOnly}
      onChange={e => { setValue(e.target.value); onChange([{ type: "paragraph", content: e.target.value }]); }} />;
  };
  WikiEditor.preload = () => Promise.resolve(WikiEditor);
  return { WikiEditor };
});
vi.mock("@/features/wiki/components/wiki-comments-panel", () => ({ WikiCommentsPanel: () => null }));
vi.mock("@/features/wiki/components/share-page-dialog", () => ({ SharePageDialog: () => null }));
vi.mock("@/components/shared/emoji-picker", () => ({ EmojiPicker: () => null }));

let client: QueryClient;
let serial = 0;
let id: string;
let stored: any;
let requestLog: {path: string; json: any}[];
let getPageCount: number;
let nextPatch: undefined | (() => Promise<any>);
let nextRestore: undefined | (() => Promise<any>);
let closeDeferred: (() => void)[];
const versions = () => ["one", "two"].map((v, index) => ({
  id: `version-${v}`, pageId: id, versionNumber: 1, name: `Saved ${v}`,
  title: `Saved ${v}`, content: [{type:"paragraph", content:v}],
  createdAt: "2026-11-01T00:00:00.000Z", createdBy: {id:"history-user", displayName:"Editor"},
  isAutoSave: false,
}));
const doc = (text: string) => [{type:"paragraph", content:text}];
function wrapper({ children }: {children: ReactNode}) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function view(pageId = id) { return <WikiPageView pageId={pageId} workspaceId="history-workspace" onNavigatePage={() => {}} />; }
function deferredResponse() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  closeDeferred.push(() => resolve({data: structuredClone(stored)}));
  return {promise, resolve};
}
function conflict(code = "REVISION_CONFLICT") {
  return Object.assign(new Error(code === "EDIT_LOCKED" ? "Another editor holds this page" : "This page changed"), {
    statusCode:409, code, current:{revision:stored.revision, updatedAt:stored.updatedAt},
  });
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount() {
  const screen = render(view(), {wrapper});
  await waitFor(() => expect((screen.getByLabelText("History body carrier") as HTMLTextAreaElement).disabled).toBe(false));
  return screen;
}
async function open(screen: ReturnType<typeof render>) {
  fireEvent.click(screen.getByText("History"));
  await waitFor(() => expect(screen.getByText("Version History")).toBeTruthy());
  await waitFor(() => expect(screen.getAllByTitle("Restore this version")).toHaveLength(2));
}
const restores = () => requestLog.filter(row => row.path.includes("/restore"));

beforeEach(() => {
  id = `history-${++serial}`;
  requestLog = []; getPageCount = 0; closeDeferred = []; nextPatch = undefined; nextRestore = undefined;
  stored = {id,spaceId:"history-space",title:"Current six",content:doc("Base six"),revision:6,
    updatedAt:"2026-11-01T00:00:00.000Z",icon:null};
  client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false}}});
  useAuthStore.setState({user:{id:"history-user",email:"history@example.test",displayName:"Editor",
    avatarUrl:null,phone:null,jobTitle:null,timezone:null,emailVerified:true}});
  http.get.mockImplementation((path:string) => ({json:async () => {
    if(path.endsWith("/breadcrumbs")) return {data:[]};
    if(path.includes("/versions")) return {data:versions(),meta:{total:2,page:1,limit:50}};
    if(path.endsWith("/lock")) return {data:{id:"lock-"+id,pageId:id,userId:"history-user",user:{displayName:"Editor"}}};
    if(path===`wiki/pages/${id}`) { getPageCount++;return {data:structuredClone(stored)}; }
    throw new Error("Unexpected ordinary GET "+path);
  }}));
  http.patch.mockImplementation((path:string,options:any) => path.endsWith("/heartbeat") ? Promise.resolve() : {json:async () => {
    requestLog.push({path,json:structuredClone(options?.json)});
    if(nextPatch) return nextPatch();
    const {expectedRevision,...fields}=options.json;
    expect(expectedRevision).toBe(stored.revision);
    Object.assign(stored,fields,{revision:stored.revision+1});
    return {data:structuredClone(stored)};
  }});
  http.post.mockImplementation((path:string,options:any) => ({json:async () => {
    requestLog.push({path,json:options?.json===undefined?undefined:structuredClone(options.json)});
    if(path.includes("/restore")) {
      if(nextRestore) return nextRestore();
      const selected=versions().find(v=>path===`wiki/versions/${v.id}/restore`)!;
      expect(selected).toBeTruthy();
      Object.assign(stored,{title:selected.title,content:selected.content,revision:stored.revision+1});
      return {data:structuredClone(stored)};
    }
    throw new Error("Unexpected ordinary POST "+path);
  }}));
  http.delete.mockResolvedValue(undefined);
});
afterEach(async () => {
  // Settle only responses this case owns, even following an expected assertion
  // failure. No unrelated timer advance, global Event substitution or error filter.
  await act(async () => { for(const resolve of closeDeferred) resolve(); await Promise.resolve(); });
  cleanup(); await settle(); client.clear(); vi.clearAllMocks();
});

it("historical restore: flush waits for own ACK and restore uses acknowledged revision", async () => {
  const response=deferredResponse(); nextPatch=()=>response.promise;
  const screen=await mount();
  fireEvent.change(screen.getByLabelText("History body carrier"),{target:{value:"Own pending draft"}});
  fireEvent.click(screen.getByText("History"));
  await waitFor(()=>expect(requestLog.filter(x=>x.path===`wiki/pages/${id}`)).toHaveLength(1));
  expect(screen.queryByText("Version History")).toBeNull(); expect(restores()).toHaveLength(0);
  Object.assign(stored,{content:doc("Own pending draft"),revision:7});
  await act(async()=>{response.resolve({data:structuredClone(stored)});});
  await waitFor(()=>expect(screen.getAllByTitle("Restore this version")).toHaveLength(2));
  fireEvent.click(screen.getAllByTitle("Restore this version")[0]);
  await waitFor(()=>expect(restores()).toHaveLength(1));
  expect(restores()[0]).toEqual({path:"wiki/versions/version-one/restore",json:{expectedRevision:7}});
});
it("historical restore: live cache advance cannot rebase an open panel", async()=>{
 const screen=await mount();await open(screen);
 Object.assign(stored,{title:"Newer eight",content:doc("Other eight"),revision:8});
 await act(async()=>{await client.invalidateQueries({queryKey:queryKeys.wikiPage(id),exact:true});});
 await waitFor(()=>expect(screen.getByRole("heading",{name:"Newer eight"})).toBeTruthy());
 fireEvent.click(screen.getAllByTitle("Restore this version")[1]);await waitFor(()=>expect(restores()).toHaveLength(1));
 expect(restores()[0]).toEqual({path:"wiki/versions/version-two/restore",json:{expectedRevision:6}});
});
it("historical restore: stale refusal retains History and refreshes content without retry",async()=>{
 const screen=await mount();await open(screen);const priorReads=getPageCount;
 Object.assign(stored,{title:"Review newer eight",content:doc("Review other eight"),revision:8});nextRestore=()=>Promise.reject(conflict());
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);await waitFor(()=>expect(notices.error).toHaveBeenCalledTimes(1));
 expect(screen.getByText("Version History")).toBeTruthy();expect(screen.getByText("Saved one")).toBeTruthy();
 await waitFor(()=>expect(getPageCount).toBeGreaterThan(priorReads));
 await waitFor(()=>expect(screen.getByRole("heading",{name:"Review newer eight"})).toBeTruthy());
 expect(screen.getByRole("alert").textContent).toMatch(/changed/i);
 expect(screen.getByRole("alert").textContent).toMatch(/close|reopen/i);
 for(const button of screen.getAllByTitle("Restore this version")) expect((button as HTMLButtonElement).disabled).toBe(true);
 await settle();expect(restores()).toHaveLength(1);
});
it("historical restore: deliberate close review reopen captures fresh base and can conflict again",async()=>{
 const screen=await mount();await open(screen);
 Object.assign(stored,{title:"Review eight",content:doc("Eight"),revision:8});nextRestore=()=>Promise.reject(conflict());
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);await waitFor(()=>expect(notices.error).toHaveBeenCalledTimes(1));
 await waitFor(()=>expect(screen.getByRole("heading",{name:"Review eight"})).toBeTruthy());
 fireEvent.click(screen.getByText("History"));await waitFor(()=>expect(screen.queryByText("Version History")).toBeNull());
 await open(screen);Object.assign(stored,{title:"Nine intervened",content:doc("Nine"),revision:9});
 fireEvent.click(screen.getAllByTitle("Restore this version")[1]);await waitFor(()=>expect(restores()).toHaveLength(2));
 expect(restores()[1]).toEqual({path:"wiki/versions/version-two/restore",json:{expectedRevision:8}});
 await waitFor(()=>expect(notices.error).toHaveBeenCalledTimes(2));await settle();expect(restores()).toHaveLength(2);
});
it("historical restore: doubleclick pending restore is one request and success closes History",async()=>{
 const response=deferredResponse();nextRestore=()=>response.promise;const screen=await mount();await open(screen);
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);await waitFor(()=>expect(restores()).toHaveLength(1));
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);expect(restores()).toHaveLength(1);
 expect(screen.getByText("Version History")).toBeTruthy();
 await act(async()=>{response.resolve({data:structuredClone(stored)});});
 await waitFor(()=>expect(screen.queryByText("Version History")).toBeNull());expect(notices.success).toHaveBeenCalledTimes(1);
});
it("historical restore: ordinary failure retains History with one useful fallback",async()=>{
 nextRestore=()=>Promise.reject(new Error("Offline restore"));const screen=await mount();await open(screen);
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);await waitFor(()=>expect(notices.error).toHaveBeenCalledWith("Offline restore"));
 expect(screen.getByText("Version History")).toBeTruthy();expect(restores()).toHaveLength(1);
});
it("historical restore: other-user lock refusal stays distinct",async()=>{
 nextRestore=()=>Promise.reject(conflict("EDIT_LOCKED"));const screen=await mount();await open(screen);
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);await waitFor(()=>expect(notices.error).toHaveBeenCalledWith("Another editor holds this page"));
 expect(screen.getByText("Version History")).toBeTruthy();expect(restores()).toHaveLength(1);
});
it("historical restore: failed pending save cannot open History or restore",async()=>{
 nextPatch=()=>Promise.reject(new Error("Offline save"));const screen=await mount();
 fireEvent.change(screen.getByLabelText("History body carrier"),{target:{value:"Unsaved ordinary draft"}});
 fireEvent.click(screen.getByText("History"));await waitFor(()=>expect(screen.getByRole("alert").textContent).toMatch(/Changes not saved/i));
 expect(screen.queryByText("Version History")).toBeNull();expect(restores()).toHaveLength(0);
 expect((screen.getByLabelText("History body carrier") as HTMLTextAreaElement).value).toContain("Unsaved ordinary draft");
});

// Fresh-read and deliberately reviewed retry regressions.
function holdPageReads() {
  const original = http.get.getMockImplementation()!;
  const response = deferredResponse();
  http.get.mockImplementation((path: string, ...args: any[]) => path === `wiki/pages/${id}`
    ? {json: () => { getPageCount++; return response.promise; }}
    : original(path, ...args));
  return {response, restoreReads: () => http.get.mockImplementation(original)};
}
it("historical restore: closing History during conflict refresh cannot reopen on the rejected base",async()=>{
 const screen=await mount();await open(screen);
 const held=holdPageReads();Object.assign(stored,{title:"Review held eight",content:doc("Remote eight"),revision:8});
 nextRestore=()=>Promise.reject(conflict());
 fireEvent.click(screen.getAllByTitle("Restore this version")[0]);
 await waitFor(()=>expect(getPageCount).toBe(2));
 await waitFor(()=>expect(notices.error).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByText("History"));expect(screen.queryByText("Version History")).toBeNull();
 fireEvent.click(screen.getByText("History"));await settle();
 console.info("History held-refresh observation",{cachedRevision:(client.getQueryData(queryKeys.wikiPage(id)) as any)?.data?.revision,panelOpen:!!screen.queryByText("Version History"),toast:notices.error.mock.calls[0]?.[0]});
 expect(screen.queryByText("Version History")).toBeNull();
 expect((screen.getByText("History").closest("button") as HTMLButtonElement).disabled).toBe(true);
 expect(restores()).toHaveLength(1);
 await act(async()=>{held.response.resolve({data:structuredClone(stored)});});held.restoreReads();
 await waitFor(()=>expect(screen.getByRole("heading",{name:"Review held eight"})).toBeTruthy());
 expect(screen.queryByText("Version History")).toBeNull();
 await waitFor(()=>expect((screen.getByText("History").closest("button") as HTMLButtonElement).disabled).toBe(false));
 nextRestore=undefined;await open(screen);fireEvent.click(screen.getAllByTitle("Restore this version")[1]);
 await waitFor(()=>expect(restores()).toHaveLength(2));
 expect(restores()[1]).toEqual({path:"wiki/versions/version-two/restore",json:{expectedRevision:8}});
 expect(notices.error.mock.calls[0][0]).toMatch(/History.*review|review.*History/i);
});
it("historical restore: skipped save cache ACK requires fresh displayed content before History opens",async()=>{
 const patch=deferredResponse();nextPatch=()=>patch.promise;
 const screen=await mount();const held=holdPageReads();
 fireEvent.change(screen.getByLabelText("History body carrier"),{target:{value:"Own seven"}});
 fireEvent.click(screen.getByText("History"));await waitFor(()=>expect(requestLog.filter(x=>x.path===`wiki/pages/${id}`)).toHaveLength(1));
 const cancel=vi.spyOn(client,"cancelQueries").mockRejectedValueOnce(new Error("Owned cache cancellation unavailable"));
 Object.assign(stored,{title:"Review own seven",content:doc("Own seven"),revision:7});
 await act(async()=>{patch.resolve({data:structuredClone(stored)});});await settle();
 expect(cancel).toHaveBeenCalledTimes(1);
 console.info("History skipped-ACK observation",{serverAcknowledgedRevision:7,cachedRevision:(client.getQueryData(queryKeys.wikiPage(id)) as any)?.data?.revision,panelOpen:!!screen.queryByText("Version History")});
 expect(screen.queryByText("Version History")).toBeNull();
 await waitFor(()=>expect(getPageCount).toBe(2));expect(restores()).toHaveLength(0);
 await act(async()=>{held.response.resolve({data:structuredClone(stored)});});held.restoreReads();
 await waitFor(()=>expect(screen.getByRole("heading",{name:"Review own seven"})).toBeTruthy());
 expect(screen.queryByText("Version History")).toBeNull();
 await waitFor(()=>expect((screen.getByText("History").closest("button") as HTMLButtonElement).disabled).toBe(false));
 await open(screen);fireEvent.click(screen.getAllByTitle("Restore this version")[0]);await waitFor(()=>expect(restores()).toHaveLength(1));
 expect(restores()[0]).toEqual({path:"wiki/versions/version-one/restore",json:{expectedRevision:7}});
});
