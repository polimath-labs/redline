# Redline colors

| Name    | Hex       | Use                                          |
| ------- | --------- | -------------------------------------------- |
| Carmine | `#D90036` | Brand color. App avatar, the `_` cursor, links |
| Ink     | `#0A0A0A` | Text, dark backgrounds, cursor on carmine    |
| White   | `#FFFFFF` | The `r` on carmine and ink, light backgrounds |
| Tint    | `#FBE6EB` | Carmine at 10% on white. Pills, highlights, with Ink text |
| Muted   | `#6B6B6B` | Secondary text. 5.3:1 on white, passes AA     |

Wordmark: `redline_` in JetBrains Mono, with the `_` in Carmine.

```css
:root {
  --carmine: #d90036;
  --ink: #0a0a0a;
  --white: #ffffff;
  --tint: #fbe6eb;
  --muted: #6b6b6b;
}
```
