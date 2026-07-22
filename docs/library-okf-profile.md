# Open Library OKF Profile

## Profile version 1.0

Target: [Open Knowledge Format 0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

This document defines a vendor-neutral OKF profile for exchanging personal ebook and paper libraries. It does not require LightRead software, an account, a hosted service, or a proprietary SDK. Producers and consumers may implement the profile using any ZIP, Markdown, and YAML tooling.

## 1. Bundle

A conforming distribution is an OKF bundle directory or a ZIP archive of that directory. ZIP files should use the `.okf.zip` suffix and the `application/zip` media type.

```text
bundle/
├── index.md
├── books/
│   ├── index.md
│   └── <concept-id>.md
├── catalogs/
│   ├── index.md
│   └── <concept-id>.md
└── assets/
    └── books/<concept-id>/
        ├── content.<format>
        └── cover.<format>             # optional
```

The root `index.md` declares `okf_version: "0.1"` in its frontmatter as permitted by OKF 0.1. All non-reserved Markdown documents are OKF concepts and contain the required `type` field. Binary assets are ordinary bundle resources; they do not need Markdown wrappers.

Paths in the `file` and `cover` objects are bundle-root-relative. The standard OKF `resource` field is a URI reference relative to the concept document.

## 2. Publication concept

Each book or paper is represented by one concept. Standard OKF fields remain useful to consumers that do not implement this profile.

```yaml
---
type: Book
title: Example Book
description: A short description of the publication.
resource: ../assets/books/550e8400/content.epub
tags: [fiction, unread]
timestamp: 2026-07-22T08:00:00.000Z
profile: https://github.com/yzfly/LightRead/blob/main/docs/library-okf-profile.md#profile-version-10
entity: book
id: 550e8400
authors:
  - Example Author
language: en
collection: books
provenance: Local import
file:
  path: assets/books/550e8400/content.epub
  name: example.epub
  format: epub
  media_type: application/epub+zip
  byte_length: 123456
  sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
cover:
  path: assets/books/550e8400/cover.jpg
  name: cover.jpg
  media_type: image/jpeg
  byte_length: 12345
  sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
reading_state:
  added_at: 2026-07-20T08:00:00.000Z
  last_read_at: 2026-07-22T08:00:00.000Z
  location: epubcfi(...)
  progress: 0.42
  reading_seconds: 3600
  pinned_at: 2026-07-21T08:00:00.000Z
annotations:
  - id: annotation-1
    type: highlight
    location: epubcfi(...)
    text: Highlighted text
    note: A reader note
    color: yellow
    created_at: 2026-07-22T08:00:00.000Z
---
```

### 2.1 Fields

| Field | Requirement | Meaning |
|---|---:|---|
| `type` | required by OKF | `Book`, `Publication`, `Scholarly Paper`, or another descriptive publication type. |
| `title` | recommended by OKF | Human-readable publication title. |
| `description` | recommended by OKF | One-line summary. Longer text belongs in the Markdown body. |
| `resource` | recommended by OKF | URI reference to the primary bundled content. |
| `tags` | optional by OKF | YAML list of portable category strings. |
| `timestamp` | optional by OKF | Last meaningful metadata or reading-state change in ISO 8601 form. |
| `profile` | required by this profile | Stable URL identifying this field profile. |
| `entity` | required by this profile | `book`; used for routing without relying on a fixed `type` taxonomy. |
| `id` | required by this profile | Bundle-local stable identifier. Consumers may assign a different local ID. |
| `authors` | required by this profile | Ordered YAML list of author display names; an empty list is allowed. |
| `language` | optional | BCP 47 language tag when known. |
| `collection` | required | `books` or `papers`. |
| `provenance` | optional | Human-readable acquisition source. |
| `file` | required | Primary content resource descriptor. |
| `cover` | optional | Cover image resource descriptor. |
| `reading_state` | optional | Device-independent reading state where possible. |
| `annotations` | optional | Ordered list of bookmarks, highlights, and notes. |

Every `file` resource descriptor requires `path`, `name`, `format`, `media_type`, `byte_length`, and `sha256`. A `cover` descriptor requires the same fields except `format`. SHA-256 is calculated over the uncompressed ZIP entry bytes and encoded as 64 lowercase hexadecimal characters.

Supported `format` values in Profile 1.0 are `epub`, `mobi`, `azw3`, `azw`, `fb2`, `fbz`, `cbz`, `cbr`, `djvu`, `pdf`, `txt`, `html`, and `md`. Consumers must ignore unsupported concepts rather than treating unrelated OKF concepts as invalid.

`progress` is a number from 0 through 1. Locations are format-specific opaque strings: EPUB-family readers commonly use CFI, while PDF readers may use a page number. Consumers that do not understand a location syntax may preserve it unchanged.

Annotations are also rendered under an `# Annotations` heading in the Markdown body. This deliberate duplication keeps notes useful to plain Markdown and AI consumers while retaining deterministic machine import.

## 3. Catalog concept

Optional OPDS and scholarly catalog subscriptions use a separate concept:

```yaml
---
type: OPDS Catalog
title: Example Catalog
description: An open publication catalog.
resource: https://example.org/opds
tags: [catalog, opds]
timestamp: 2026-07-22T08:00:00.000Z
profile: https://github.com/yzfly/LightRead/blob/main/docs/library-okf-profile.md#profile-version-10
entity: catalog
id: catalog-1
catalog_kind: opds
url: https://example.org/opds
added_at: 2026-07-22T08:00:00.000Z
---
```

`catalog_kind` is `opds` or `arxiv`. Authentication usernames, passwords, tokens, cookies, and request headers must not be exported.

## 4. Consumer behavior

A Profile 1.0 consumer should:

1. Parse every non-reserved Markdown concept as OKF and tolerate unknown types and extension fields.
2. Select publication concepts by `entity: book`, or generically by a publication-like `type` plus a local `file`/`resource`.
3. Resolve bundle resources without allowing paths to escape the bundle root.
4. Verify declared byte lengths and SHA-256 values before writing any library data.
5. Preserve unknown fields when editing a bundle in place. An application ingesting concepts into a narrower database may ignore fields it cannot represent.
6. Keep existing local publications on identity conflicts and merge annotations by content identity, unless the user chooses another conflict policy.

A generic OKF producer does not have to emit every Profile field to be useful. LightRead accepts publication concepts from other producers when they have a supported bundled resource; missing reading state defaults to an unread local import.

## 5. Versioning and extensibility

The profile URL and `profile` value include the profile version. New optional fields may be added compatibly. A breaking field or semantic change requires a new major profile version and a new version fragment.

OKF explicitly permits producer-defined frontmatter fields. This profile uses that extension mechanism while keeping discovery, titles, descriptions, resources, tags, timestamps, indexes, links, and human-readable bodies within the shared OKF interoperability surface.
