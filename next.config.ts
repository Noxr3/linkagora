import type { NextConfig } from "next";

// Docs pages whose address carried the old name, with and without .md.
const RENAMED_DOCS: [string, string][] = [
  ['welcome-to-openagora', 'welcome-to-linkagora'],
  ['how-agents-use-openagora', 'how-agents-use-linkagora'],
  ['del-inside-openagora-s-own-a2a-agent', 'del-inside-linkagora-s-own-a2a-agent'],
  ['openagora-vs-agentverse-choosing-an-ai-agent-registry-in-2026', 'linkagora-vs-agentverse-choosing-an-ai-agent-registry-in-2026'],
  ['why-your-ai-agent-needs-a-health-check-and-how-openagora-does-it', 'why-your-ai-agent-needs-a-health-check-and-how-linkagora-does-it'],
];

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The old domain. Pages move to the new one; /api and /relay keep answering
      // here, because a redirect to another host drops the Authorization header and
      // every agent calling with its key would start getting 401.
      {
        source: "/:path((?!api/|relay/|_next/).*)",
        has: [{ type: "host", value: "(?:www\\.)?openagora\\.cc" }],
        destination: "https://linkagora.dev/:path",
        permanent: true,
      },
      {
        source: "/:path(.*)",
        has: [{ type: "host", value: "www\\.linkagora\\.dev" }],
        destination: "https://linkagora.dev/:path",
        permanent: true,
      },
      ...RENAMED_DOCS.flatMap(([from, to]) => [
        { source: `/docs/${from}`, destination: `/docs/${to}`, permanent: true },
        { source: `/docs/${from}.md`, destination: `/docs/${to}.md`, permanent: true },
      ]),
      { source: "/openagora.skill.md", destination: "/linkagora.skill.md", permanent: true },
      // An interactive diagram on the old docs host; its argument lives in this post.
      {
        source: "/docs/reddit-vs-linkedin-architecture-flow",
        destination: "/docs/agents-don-t-need-a-reddit-they-need-a-linkedin",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        // The OAuth consent page and endpoints: never framed (clickjacking an
        // "Allow" click), never cached, and no Referer with the authorization
        // request's parameters to other sites. "same-origin" keeps the Origin
        // header on the consent form's POST, which /oauth/authorize checks.
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // The page that shows a sign-in code to paste into a terminal: plain HTML
        // with nothing to run or load. Later rules win over the one above, and over
        // anything the route itself sets, so this is where its headers have to live.
        source: "/oauth/cli/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      // Agents read any docs page as Markdown by adding .md to its URL.
      { source: "/docs/:slug([a-z0-9-]+).md", destination: "/api/docs/:slug" },
    ];
  },
  // Docs are read from disk at build time; keep the files with the functions too.
  outputFileTracingIncludes: {
    "/docs/[slug]": ["./content/docs/**/*"],
    "/api/docs/[slug]": ["./content/docs/**/*"],
    "/llms.txt": ["./content/docs/**/*"],
    "/sitemap.xml": ["./content/docs/**/*"],
  },
};

export default nextConfig;
