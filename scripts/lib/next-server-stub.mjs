// Stub for `next/server` so standalone replay scripts can import the assess route module under plain
// Node (Next's subpath export doesn't resolve outside the bundler). The replay harness only ever
// calls the pure runAssessment() — never the GET handler — so NextResponse is never invoked at
// runtime; this stub merely satisfies the top-level import. Dev tooling only. (Cowork §7/§8.)
export const NextResponse = {
  json: (body, init) => ({ __nextResponseStub: true, body, init }),
};
