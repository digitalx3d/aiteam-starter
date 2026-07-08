"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: ({ ...props }) => <p className="my-2 leading-relaxed" {...props} />,
  ul: ({ ...props }) => <ul className="list-disc pl-5 my-2 space-y-0.5" {...props} />,
  ol: ({ ...props }) => <ol className="list-decimal pl-5 my-2 space-y-0.5" {...props} />,
  li: ({ ...props }) => <li className="leading-relaxed" {...props} />,
  code: ({ children, className, ...props }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} font-mono text-xs`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="px-1 py-0.5 rounded bg-tool-bg border border-tool-border text-xs font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ ...props }) => (
    <pre
      className="my-2 p-3 bg-tool-bg border border-tool-border rounded-md overflow-x-auto text-xs"
      {...props}
    />
  ),
  h1: ({ ...props }) => <h1 className="text-base font-semibold mt-4 mb-2" {...props} />,
  h2: ({ ...props }) => <h2 className="text-sm font-semibold mt-3 mb-2" {...props} />,
  h3: ({ ...props }) => <h3 className="text-sm font-semibold mt-3 mb-1" {...props} />,
  h4: ({ ...props }) => <h4 className="text-sm font-medium mt-2 mb-1" {...props} />,
  a: ({ ...props }) => (
    <a className="underline hover:opacity-80" target="_blank" rel="noreferrer" {...props} />
  ),
  strong: ({ ...props }) => <strong className="font-semibold" {...props} />,
  em: ({ ...props }) => <em className="italic" {...props} />,
  hr: ({ ...props }) => <hr className="my-3 border-border" {...props} />,
  blockquote: ({ ...props }) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-foreground/75" {...props} />
  ),
  table: ({ ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ ...props }) => (
    <th
      className="border border-border px-2 py-1 text-left font-medium bg-muted-bg"
      {...props}
    />
  ),
  td: ({ ...props }) => <td className="border border-border px-2 py-1 align-top" {...props} />,
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  if (!children) return null;
  return (
    <div className="markdown-body text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
