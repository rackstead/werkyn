import { FileDownloadButton, FormattingToolbar, FormattingToolbarController, getFormattingToolbarItems, useBlockNoteEditor, useComponentsContext, useEditorState } from "@blocknote/react";
import { Download } from "lucide-react";
import { useCallback } from "react";
import { isUploadedMediaUrl, type UploadedMediaOwner } from "@/lib/uploaded-media";

export function UploadedMediaToolbar({ owner }: { owner: UploadedMediaOwner }) {
  const toolbar = useCallback(() => <FormattingToolbar>{getFormattingToolbarItems().map(item => item.key === "fileDownloadButton" ? <UploadedFileDownload key="fileDownloadButton" owner={owner} /> : item)}</FormattingToolbar>, [owner]);
  return <FormattingToolbarController formattingToolbar={toolbar} />;
}

export function UploadedFileDownload({ owner }: { owner: UploadedMediaOwner }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const block = useEditorState({ editor, selector: ({ editor }) => {
    const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
    if (blocks.length !== 1) return undefined;
    const selected = blocks[0];
    return "url" in selected.props && typeof selected.props.url === "string" ? selected : undefined;
  } });
  if (!block || !("url" in block.props) || typeof block.props.url !== "string" || !isUploadedMediaUrl(block.props.url)) return <FileDownloadButton />;
  const url = block.props.url;
  const name = "name" in block.props && typeof block.props.name === "string" ? block.props.name : "download";
  return <Components.FormattingToolbar.Button className="bn-button" label="Download file" mainTooltip="Download file" icon={<Download size={16} />} onClick={() => { editor.focus(); void owner.download(url, name).catch(() => {}); }} />;
}
