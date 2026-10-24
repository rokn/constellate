import { gunzipSync, inflateSync } from "node:zlib";
import type { SpanKind, TraceSpan } from "../shared/types";

/**
 * Spans in, in every shape they arrive in: OTLP/HTTP as protobuf (what the
 * Go, Java and .NET SDKs send) or JSON (the JS SDK, a collector's file
 * exporter, Tempo's trace API), and Jaeger's query API. All of it comes out
 * as TraceSpan, without a location: pinning spans to files is traces.ts's.
 *
 * The protobuf reader is written out by hand for the few messages a trace
 * export uses, so taking spans in needs no generated code.
 */

type Attrs = Record<string, string | number | boolean>;

/** Long string attributes (SQL, stack traces) are cut; only so many are kept per span. */
const MAX_ATTR_CHARS = 300;
const MAX_ATTRS = 40;

const KINDS: SpanKind[] = ["internal", "internal", "server", "client", "producer", "consumer"];

/** An OTLP span kind, as a number or as "SPAN_KIND_SERVER". */
function kindOf(v: unknown): SpanKind {
  if (typeof v === "number") return KINDS[v] ?? "internal";
  if (typeof v === "string") {
    const k = v.replace(/^SPAN_KIND_/, "").toLowerCase();
    if (/^\d+$/.test(k)) return KINDS[Number(k)] ?? "internal";
    return (KINDS as string[]).includes(k) ? (k as SpanKind) : "internal";
  }
  return "internal";
}

function putAttr(into: Attrs, key: string, value: unknown) {
  if (Object.keys(into).length >= MAX_ATTRS && !(key in into)) return;
  if (typeof value === "string") into[key] = value.length > MAX_ATTR_CHARS ? `${value.slice(0, MAX_ATTR_CHARS)}…` : value;
  else if (typeof value === "number" || typeof value === "boolean") into[key] = value;
  else if (typeof value === "bigint") into[key] = Number(value);
  else if (value !== undefined && value !== null) putAttr(into, key, JSON.stringify(value));
}

/** Read the body of an OTLP request, gzip or deflate undone. */
export function decodeBody(raw: Buffer, encoding?: string): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (enc.includes("gzip") || (raw[0] === 0x1f && raw[1] === 0x8b)) return gunzipSync(raw);
  if (enc.includes("deflate")) return inflateSync(raw);
  return raw;
}

/** An OTLP/HTTP trace export, as protobuf or JSON (or JSON lines, as a collector's file exporter writes). */
export function parseOtlp(body: Buffer, contentType?: string): TraceSpan[] {
  const json = /json/i.test(contentType ?? "") || (!/protobuf/i.test(contentType ?? "") && /^\s*[{[]/.test(body.subarray(0, 64).toString()));
  if (!json) return parseProtobuf(body);
  const text = body.toString("utf8").trim();
  try {
    return parseOtlpJson(JSON.parse(text));
  } catch (err) {
    // JSON lines: one export per line.
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) throw err;
    return lines.flatMap((l) => parseOtlpJson(JSON.parse(l)));
  }
}

/* ------------------------------- OTLP JSON ------------------------------- */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** camelCase or snake_case: the spec says camel, some exporters write snake. */
const pick = (o: Json, camel: string) => o[camel] ?? o[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];

/** Ids are hex in OTLP JSON, base64 in protojson (Tempo); always hex out. */
function hexId(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  if (/^[0-9a-f]+$/i.test(v) && (v.length === 32 || v.length === 16)) return v.toLowerCase();
  return Buffer.from(v, "base64").toString("hex");
}

function anyValue(v: unknown): unknown {
  const o = obj(v);
  for (const k of ["stringValue", "boolValue", "doubleValue"]) {
    const x = pick(o, k);
    if (x !== undefined) return x;
  }
  const i = pick(o, "intValue");
  if (i !== undefined) return Number(i);
  const a = pick(o, "arrayValue");
  if (a !== undefined) return arr(obj(a).values).map(anyValue);
  const kv = pick(o, "kvlistValue");
  if (kv !== undefined) return Object.fromEntries(arr(obj(kv).values).map((e) => [String(obj(e).key), anyValue(obj(e).value)]));
  return undefined;
}

function jsonAttrs(list: unknown, into: Attrs = {}): Attrs {
  for (const e of arr(list)) putAttr(into, String(obj(e).key), anyValue(obj(e).value));
  return into;
}

/** Nanoseconds since the epoch (a string, so they keep their digits) to milliseconds. */
function nsToMs(v: unknown): number {
  if (typeof v === "number") return v / 1e6;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(BigInt(v) / 1000n) / 1000;
  return 0;
}

/** An ExportTraceServiceRequest, or what Tempo's trace API returns (`batches`, or `trace` around either). */
export function parseOtlpJson(doc: unknown): TraceSpan[] {
  let root = obj(doc);
  if (root.trace) root = obj(root.trace);
  const out: TraceSpan[] = [];
  for (const rs of arr(pick(root, "resourceSpans") ?? root.batches)) {
    const resource = jsonAttrs(obj(obj(rs).resource).attributes);
    const scopes = arr(pick(obj(rs), "scopeSpans") ?? pick(obj(rs), "instrumentationLibrarySpans"));
    for (const ss of scopes) {
      const scope = obj(obj(ss).scope ?? pick(obj(ss), "instrumentationLibrary"));
      for (const sp of arr(obj(ss).spans)) {
        const s = obj(sp);
        const start = nsToMs(pick(s, "startTimeUnixNano"));
        const end = nsToMs(pick(s, "endTimeUnixNano"));
        const status = obj(s.status);
        out.push(
          span({
            traceId: hexId(pick(s, "traceId")),
            spanId: hexId(pick(s, "spanId")),
            parentId: hexId(pick(s, "parentSpanId")) || undefined,
            name: String(s.name ?? ""),
            kind: kindOf(s.kind),
            start,
            end,
            error: status.code === 2 || status.code === "STATUS_CODE_ERROR",
            scope: typeof scope.name === "string" ? scope.name : undefined,
            attrs: jsonAttrs(s.attributes),
            resource,
          }),
        );
      }
    }
  }
  return out.filter((s) => s.traceId && s.spanId);
}

/* ------------------------------ OTLP protobuf ------------------------------ */

/** Just enough of the protobuf wire format to walk a message's fields. */
class Reader {
  pos = 0;
  constructor(
    private buf: Buffer,
    private end = buf.length,
  ) {}
  more() {
    return this.pos < this.end;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error("Truncated protobuf.");
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  /** The next field's number and wire type. */
  tag(): [number, number] {
    const t = Number(this.varint());
    return [t >>> 3, t & 7];
  }
  bytes(): Buffer {
    const n = Number(this.varint());
    if (this.pos + n > this.end) throw new Error("Truncated protobuf.");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  fixed64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  double(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}.`);
  }
}

/** Each field of a message, as its number, wire type and a reader positioned on its value. */
function* fields(buf: Buffer): Generator<[number, number, Reader]> {
  const r = new Reader(buf);
  while (r.more()) {
    const [n, w] = r.tag();
    const at = r.pos;
    yield [n, w, r];
    // A field the caller didn't read is skipped here.
    if (r.pos === at) r.skip(w);
  }
}

const str = (r: Reader) => r.bytes().toString("utf8");
/** int64 as two's complement: negative numbers come back negative. */
const int64 = (v: bigint) => Number(BigInt.asIntN(64, v));

function pbAnyValue(buf: Buffer): unknown {
  for (const [n, w, r] of fields(buf)) {
    if (n === 1 && w === 2) return str(r);
    if (n === 2 && w === 0) return r.varint() !== 0n;
    if (n === 3 && w === 0) return int64(r.varint());
    if (n === 4 && w === 1) return r.double();
    if (n === 5 && w === 2) {
      const vals: unknown[] = [];
      for (const [m, mw, rr] of fields(r.bytes())) if (m === 1 && mw === 2) vals.push(pbAnyValue(rr.bytes()));
      return vals;
    }
    if (n === 6 && w === 2) {
      const kv: Attrs = {};
      for (const [m, mw, rr] of fields(r.bytes())) if (m === 1 && mw === 2) pbKeyValue(rr.bytes(), kv);
      return kv;
    }
    if (n === 7 && w === 2) return r.bytes().toString("base64");
  }
  return undefined;
}

function pbKeyValue(buf: Buffer, into: Attrs) {
  let key = "";
  let value: unknown;
  for (const [n, w, r] of fields(buf)) {
    if (n === 1 && w === 2) key = str(r);
    else if (n === 2 && w === 2) value = pbAnyValue(r.bytes());
  }
  if (key) putAttr(into, key, value);
}

/** Attributes (field 1) of a Resource or an InstrumentationScope's name (field 1, a string). */
function pbResource(buf: Buffer): Attrs {
  const attrs: Attrs = {};
  for (const [n, w, r] of fields(buf)) if (n === 1 && w === 2) pbKeyValue(r.bytes(), attrs);
  return attrs;
}

function pbScopeName(buf: Buffer): string | undefined {
  for (const [n, w, r] of fields(buf)) if (n === 1 && w === 2) return str(r);
  return undefined;
}

function pbSpan(buf: Buffer, resource: Attrs, scope?: string): TraceSpan {
  let traceId = "";
  let spanId = "";
  let parentId = "";
  let name = "";
  let kind = 0;
  let start = 0n;
  let end = 0n;
  let error = false;
  const attrs: Attrs = {};
  for (const [n, w, r] of fields(buf)) {
    if (n === 1 && w === 2) traceId = r.bytes().toString("hex");
    else if (n === 2 && w === 2) spanId = r.bytes().toString("hex");
    else if (n === 4 && w === 2) parentId = r.bytes().toString("hex");
    else if (n === 5 && w === 2) name = str(r);
    else if (n === 6 && w === 0) kind = Number(r.varint());
    else if (n === 7 && w === 1) start = r.fixed64();
    else if (n === 8 && w === 1) end = r.fixed64();
    else if (n === 9 && w === 2) pbKeyValue(r.bytes(), attrs);
    else if (n === 15 && w === 2) {
      for (const [m, mw, rr] of fields(r.bytes())) if (m === 3 && mw === 0) error = rr.varint() === 2n;
    }
  }
  return span({
    traceId,
    spanId,
    parentId: parentId || undefined,
    name,
    kind: kindOf(kind),
    start: Number(start / 1000n) / 1000,
    end: Number(end / 1000n) / 1000,
    error,
    scope,
    attrs,
    resource,
  });
}

/** opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest. */
export function parseProtobuf(buf: Buffer): TraceSpan[] {
  const out: TraceSpan[] = [];
  for (const [n, w, r] of fields(buf)) {
    if (n !== 1 || w !== 2) continue;
    // ResourceSpans: resource = 1, scope_spans = 2 (instrumentation_library_spans = 1000, before 1.0).
    let resource: Attrs = {};
    const scopes: Buffer[] = [];
    for (const [m, mw, rr] of fields(r.bytes())) {
      if (m === 1 && mw === 2) resource = pbResource(rr.bytes());
      else if ((m === 2 || m === 1000) && mw === 2) scopes.push(rr.bytes());
    }
    for (const ss of scopes) {
      // ScopeSpans: scope = 1, spans = 2.
      let scope: string | undefined;
      const spans: Buffer[] = [];
      for (const [m, mw, rr] of fields(ss)) {
        if (m === 1 && mw === 2) scope = pbScopeName(rr.bytes());
        else if (m === 2 && mw === 2) spans.push(rr.bytes());
      }
      for (const s of spans) out.push(pbSpan(s, resource, scope));
    }
  }
  return out.filter((s) => s.traceId && s.spanId);
}

/* --------------------------------- Jaeger --------------------------------- */

/** One trace from Jaeger's query API (`/api/traces/<id>`, or an entry of `/api/traces`'s data). */
export function parseJaeger(trace: unknown): TraceSpan[] {
  const t = obj(trace);
  const processes = obj(t.processes);
  const tags = (list: unknown, into: Attrs = {}) => {
    for (const e of arr(list)) putAttr(into, String(obj(e).key), obj(e).value);
    return into;
  };
  const out: TraceSpan[] = [];
  for (const sp of arr(t.spans)) {
    const s = obj(sp);
    const proc = obj(processes[String(s.processID)] ?? s.process);
    const resource = tags(proc.tags, { "service.name": String(proc.serviceName ?? "unknown") });
    const attrs = tags(s.tags);
    const parent = arr(s.references).map(obj).find((ref) => ref.refType === "CHILD_OF") ?? arr(s.references).map(obj)[0];
    const kind = kindOf(String(attrs["span.kind"] ?? "internal"));
    const scope = (attrs["otel.scope.name"] ?? attrs["otel.library.name"]) as string | undefined;
    for (const k of ["span.kind", "otel.scope.name", "otel.library.name", "internal.span.format"]) delete attrs[k];
    const start = Number(s.startTime ?? 0) / 1000;
    out.push(
      span({
        traceId: hexId(String(s.traceID ?? t.traceID ?? "").padStart(32, "0")),
        spanId: hexId(String(s.spanID ?? "").padStart(16, "0")),
        parentId: parent?.spanID ? hexId(String(parent.spanID).padStart(16, "0")) : undefined,
        name: String(s.operationName ?? ""),
        kind,
        start,
        end: start + Number(s.duration ?? 0) / 1000,
        error: attrs.error === true || attrs.error === "true" || attrs["otel.status_code"] === "ERROR",
        scope: typeof scope === "string" ? scope : undefined,
        attrs,
        resource,
      }),
    );
  }
  return out.filter((s) => s.traceId && s.spanId);
}

/* ---------------------------------- span ---------------------------------- */

/** Resource attributes worth keeping on each span: what tells services and executables apart. */
const RESOURCE_KEYS = [
  "service.namespace",
  "service.version",
  "service.instance.id",
  "process.executable.name",
  "process.executable.path",
  "process.command",
  "process.runtime.name",
  "telemetry.sdk.language",
  "k8s.deployment.name",
  "k8s.pod.name",
  "host.name",
];

function span(s: {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  start: number;
  end: number;
  error: boolean;
  scope?: string;
  attrs: Attrs;
  resource: Attrs;
}): TraceSpan {
  const attrs = s.attrs;
  // Resource attributes ride on the span under "resource." so a span on its own says where it ran.
  for (const k of RESOURCE_KEYS) if (s.resource[k] !== undefined) attrs[`resource.${k}`] = s.resource[k];
  const parentId = s.parentId && !/^0+$/.test(s.parentId) ? s.parentId : undefined;
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentId,
    service: String(s.resource["service.name"] ?? "unknown_service"),
    name: s.name,
    kind: s.kind,
    start: s.start,
    ms: Math.max(0, s.end - s.start),
    error: s.error,
    scope: s.scope,
    attrs,
  };
}
