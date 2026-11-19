# pad

A Solid app for shared collaborative editing of a very simple text document.
Forked from [timbl/pad](https://github.com/timbl/pad) (2015) and updated for current Solid servers.

- **App:** https://josephspurrier.github.io/pad/
- **Data:** a Turtle document in a Solid Pod (`pad.ttl`), stored as Tim's linked list of chunks
  (`pad:next`, `sioc:content`, `dc:author`), edited with SPARQL Update `PATCH`.

## What changed from the original

| 2015 original | This version |
|---|---|
| Runs from inside the Pod, saves `pad.ttl` next to itself (why github.io didn't work: read-only) | Code on github.io, data in the Pod at a fixed URL (or `?pad=<url>`) |
| mashlib / rdflib, WAC `.acl` files | `@inrupt/solid-client-authn-browser` 5 and N3.js; ACP access policies (Inrupt PodSpaces) |
| Solid WebSocket `solid-0.1` (`sub`/`pub`) | Solid Notifications via the Pod's notification gateway (WebSocket, `solid-0.2`) |
| Dynamic client registration | Static Client ID Document ([`client.jsonld`](client.jsonld)) |

Why not run it from the Pod any more: Inrupt serves Pod HTML with
`Content-Security-Policy: sandbox allow-scripts` (opaque origin, no storage), and treats a
login redirect such as `page.html?code=...` as a different, nonexistent resource. So the Pod
copy is a read-only, live-updating viewer; its **Edit** button opens this site.

## Deploying

- **GitHub Pages:** every push to `modern` runs [`.github/workflows/pages.yml`](.github/workflows/pages.yml),
  which publishes `index.html`, `app.js` and `client.jsonld` and stamps `app.js?v=<commit>` so
  browsers fetch the new script as soon as the page itself refreshes.
- **Pod viewer:** run `./deploy.sh`. It is not stamped: Inrupt treats `app.js?v=...` as a
  different, nonexistent resource.

## Access

`deploy.sh` copies the viewer to `<pod>/pad/`, seeds `pad.ttl` if missing, and adds a
public-read policy. Only the owner's WebID can write until the owner adds editors.

**Editors:** when the owner is logged in, the **Editors** button lists who can edit and lets
the owner add or remove people by WebID. Each editor is an `acp:agent` on one extra policy
(`#editors`, Read/Write/Append) in `pad.ttl`'s ACR, changed with small SPARQL `PATCH`es. The app
decides who can edit from the Pod's `WAC-Allow` header, not from the document, and each line
shows who wrote it on hover (`dc:author`). It reads credentials from `../.env`
(`ENV_FILE=...` to override): `SOLID_CLIENT_ID`, `SOLID_CLIENT_SECRET`, `SOLID_WEBID`, `SOLID_POD_ROOT`.

## Editing

Enter splits a line, Backspace at the start joins it to the line above, arrow keys move
between lines. Edits save automatically and appear live in every open viewer.
