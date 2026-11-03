# Editor dependency refresh

BlockNote core, React and Mantine use 0.57.0. The existing Tiptap family uses 3.31.3 throughout its direct dependencies and version alignment. Frontend Yjs 13.6.33 fulfills BlockNote's published peer minimum. The lockfile follows those parents naturally; glob and minimatch are not overridden. The declared Node floor remains 22.12.

## Stored documents

The editor retains supported stored block IDs, text, properties and nesting. The compatibility fixture contains all fourteen default block types, table cells, media metadata, separate supported formatting/code spans, a legacy code-block language and inline-array representation, and an explicit saved blank block. It comes from an independently checked old editor document and is compared as exact persisted JSON on initial load and reload.

The current library renders unused trailing input as a decoration. Clicking it creates a real paragraph. An old editor-generated extra blank paragraph is therefore no longer added automatically to serialized content; an explicit saved blank block remains data.

Backend storage accepts bounded JSON, while the editor has a document schema. The old constructor accepted a combined code/formatting span that its own complete schema check rejected. The current constructor rejects that span. The unchanged negative fixture records that distinction; it is not evidence that no such content was persisted.

In a dated pre-containment application check on main150 with the new dependency graph, the known-invalid document removed History and left the route body in an error state after navigation. Initial and idle loads produced no automatic content PATCH; raw page, version and exported backup JSON remained exact. The recovered-case input was deliberately supplied through existing public draft hooks and remained recoverable after retry. This establishes a containment failure, not an ordinary producer of that combined-mark input or a data-loss finding.

A local failure boundary contains editor constructor and passive replacement errors. It shows an unavailable-content message and a retry action without substituting an empty document, stripping marks, calling autosave or changing the stored value. The page session, History, navigation and draft queue remain outside the boundary. The failed child can retry after an actual selected-content change or an explicit retry. Healthy editors retain their instance through identical refetches and unrelated page renders.

This change introduces no stored-data migration or new draft-retention policy. Raw page values, historical versions and backups remain governed by their existing storage protocols. Actual application retention and recovery, native keyboard behavior and ordinary append actions remain part of the upgrade's independent validation.

## Remaining dependency findings

The candidate's full and production registry inventories each retain two moderate records:

| Package | Natural parent paths | Advisory |
| --- | --- | --- |
| glob 13.0.6 | `@fastify/static 10.1.8 → glob 13.0.6` | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) |
| minimatch 10.2.6 | static/glob, and independently `archiver 8.0.0 → readdir-glob 3.0.0 → minimatch 10.2.6` | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) |

The UUID record present in the dated original inventory is absent from both candidate responses. The remaining parent paths need separate supported fixes; this editor refresh does not close the broader dependency audit.
