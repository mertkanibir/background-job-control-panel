# Relay interface and identity

The interface is an operations workbench for one local queue. Its visual hierarchy follows what an operator needs to do: see execution state, control claims, select a record, then inspect the result or recover a failure.

## Identity

The [Relay mark](../public/relay-mark.svg) connects two outlined execution blocks. The offset connection suggests handing work from a queue to a worker; the small amber arrow indicates the next claim. It is an original, editable SVG used for the app identity and favicon. The [wordmark](../public/relay-wordmark.svg) pairs it with a plain lowercase name and the tool's purpose.

The mark uses a 48-unit grid, 2.5-unit strokes and three colors. It remains legible at favicon size. Leave at least 6 units of empty space around it when using it elsewhere. Keep the amber arrow intact; it is the distinguishing part of the symbol.

| Role | Color | Use |
| --- | --- | --- |
| Ink | `#172e35` | Masthead, primary action, inspector rule |
| Paper | `#fffefa` | Execution records, inspector and forms |
| Work surface | `#f3f2ed` | Page background |
| Amber | `#e6a449` | Brand arrow and masthead rule |
| Active | `#116b62` | Running metric and worker feedback |
| Failure | `#ab402b` | Dead-letter labels; failures also have text |

DM Sans is bundled for interface text. IBM Plex Mono is bundled for IDs, timestamps, numerical values, labels and code. Fonts and image assets are served from the same origin as the app. No external font or image services are used.

## Layout

- The horizontal masthead exposes queue, recovery and event-log views without a large permanent sidebar.
- Four counters share one ruled strip, rather than competing as independent cards. Every value comes from the queue snapshot; there is no seeded history or synthetic telemetry.
- Capacity positions are logical slots. They do not imply persistent worker identities, because each attempt creates a worker thread.
- Desktop uses a ledger and inspector together. The table keeps predictable column widths, with contained scrolling at intermediate widths.
- At 700px and below, the table becomes compact execution records exposing status, attempts and duration without horizontal scrolling. The selected inspector moves above the queue. Selecting a record scrolls it into view.
- Empty, loading, error, disconnected, paused and terminal states use direct language. Switching records hides the previous record immediately while the new request is pending, so its actions cannot be mistaken for the new selection. A failed detail request shows a terminal error with an explicit retry action; live queue updates preserve that state.

## Interaction and accessibility

Search matches name, ID and processor. `/` focuses it unless the user is typing, composing text or using the native dialog. Escape closes the inspector outside text inputs. Inspector tabs support Left/Right, Home and End. The native enqueue dialog retains browser focus handling and Escape behavior. A skip link moves keyboard users past the masthead.

Text accompanies every status color. Focus rings are visible on controls. Primary actions use plain language. Animations are short and limited to state feedback; the running pulse and all transitions stop under `prefers-reduced-motion`.

## Reproducing the captures

Run `npm run build`, then `npm run test:browser`. The smoke starts a production server with a temporary SQLite database, executes the real six-job demo, waits for five successes and one dead letter, selects the retry timeline, and saves:

- [Desktop](screenshot.png): 1600px wide, full-page capture.
- [Mobile](screenshot-mobile.png): 390px wide, full-page capture.

`npm run test:browser -- --record-motion` also refreshes [the interaction recording](motion-demo.webm). Screenshots disable in-flight animations for consistent capture. They contain generated demonstration inputs, not private user records. The temporary database is removed when the smoke exits.
