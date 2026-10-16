---
"@knead/graphql": patch
---

The playground's CSP no longer allows Google Fonts (the page uses system fonts), and the page is sent with `referrer-policy: no-referrer`. The README notes that the playground keeps tabs and headers in `localStorage`.
