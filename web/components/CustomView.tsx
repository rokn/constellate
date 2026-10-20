import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A visualization the navigator wrote, in a sandboxed iframe: scripts run, but
 * with an opaque origin (no allow-same-origin), so it can't touch this page,
 * its storage, or the API. A CSP closes the network to everything but d3 on
 * jsdelivr. The page talks back over postMessage for exactly two things: its
 * height, and "fly me to this file".
 */

const THEME = `
:root{--bg:#060b16;--panel:#0c1426;--panel2:#111b31;--line:#1d2a45;--text:#e4eaf4;--muted:#7d89a1;
--accent:#ffb547;--accent2:#5bd6ff;--course:#ff4fd8;--good:#6ee7a8;--bad:#ff6b6b;
--font:"Barlow",ui-sans-serif,system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace}
html,body{margin:0;background:transparent;color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
body{padding:14px 16px}
*{box-sizing:border-box}
[data-path]{cursor:pointer;transition:filter .15s,outline-color .15s;outline:1px solid transparent;outline-offset:2px}
[data-path]:hover{filter:brightness(1.25);outline-color:var(--course)}
code,pre{font-family:var(--mono);font-size:12.5px}
`;

const BRIDGE = `
<script>
(function(){
  var send=function(m){parent.postMessage(Object.assign({__codeflight:1},m),"*")};
  document.addEventListener("click",function(e){
    var el=e.target&&e.target.closest&&e.target.closest("[data-path]");
    if(!el)return;
    e.preventDefault();
    send({type:"open",path:el.getAttribute("data-path"),line:Number(el.getAttribute("data-line"))||undefined});
  });
  // Stories drive an animation in step with the narration.
  window.addEventListener("message",function(e){
    if(!e.data||!e.data.__codeflight||e.data.type!=="step")return;
    try{if(typeof window.onStoryStep==="function")window.onStoryStep(e.data.step)}catch(err){console.error(err)}
  });
  var h=function(){send({type:"height",value:Math.ceil(document.documentElement.scrollHeight)})};
  new ResizeObserver(h).observe(document.documentElement);
  window.addEventListener("load",function(){h();send({type:"loaded"})});h();
})();
<\/script>`;

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:;";

function documentFor(html: string) {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=JetBrains+Mono&display=swap" rel="stylesheet"><style>${THEME}</style>`;
  // The navigator sometimes writes a full document; graft into it rather than
  // nesting <html> inside <body>.
  if (/<html[\s>]/i.test(html)) {
    let doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${BRIDGE}</body>`) : doc + BRIDGE;
    return doc;
  }
  return `<!doctype html><html><head>${head}</head><body>${html}${BRIDGE}</body></html>`;
}

export function CustomView({
  html,
  height,
  step,
  onOpen,
}: {
  html: string;
  height?: number;
  /** A story's animation step: sent to the page's window.onStoryStep. */
  step?: number;
  onOpen: (path: string, line?: number) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(height ?? 420);
  const doc = useMemo(() => documentFor(html), [html]);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const stepRef = useRef(step);
  stepRef.current = step;
  const sendStep = () => {
    if (stepRef.current !== undefined) frame.current?.contentWindow?.postMessage({ __codeflight: 1, type: "step", step: stepRef.current }, "*");
  };
  useEffect(sendStep, [step]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Only our own frame: other custom views have their own listeners.
      if (e.source !== frame.current?.contentWindow || !e.data?.__codeflight) return;
      if (e.data.type === "height" && typeof e.data.value === "number") {
        setH(Math.min(1400, Math.max(height ?? 160, e.data.value)));
      } else if (e.data.type === "loaded") {
        // The page's own scripts have run: give it the step it should be at.
        sendStep();
      } else if (e.data.type === "open" && typeof e.data.path === "string") {
        openRef.current(e.data.path, e.data.line);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [height]);

  return (
    <iframe
      ref={frame}
      title="Visualization"
      sandbox="allow-scripts"
      srcDoc={doc}
      className="block w-full border-0"
      style={{ height: h }}
    />
  );
}
