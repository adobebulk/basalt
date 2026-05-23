---
# Sample series in the NEW data model (branch bundle — note the _index.md).
# This is a scaffold fixture: the keys point at R2 objects that don't exist yet,
# so images won't load in local preview until R2 + hostnames are set up.
# Real series will be created/managed by the admin.
title: "Iceland 2025"
description: "Volcanic landscapes and the midnight sun."
date: "2025-08-01"
draft: false
cover: "001"                 # photo id used for the homepage cover
downloadsDefault: false      # series-level default for public original downloads
photos:
  - id: "001"
    key: "iceland-2025/001"  # R2 key prefix for this photo's objects
    width: 6000
    height: 4000
    caption: "Midnight sun over the glacier"
    downloadable: true       # per-photo override of downloadsDefault
  - id: "002"
    key: "iceland-2025/002"
    width: 4000
    height: 6000
    caption: "Basalt columns at Reynisfjara"
    downloadable: false
  - id: "003"
    key: "iceland-2025/003"
    width: 6000
    height: 4000
    caption: ""
---
