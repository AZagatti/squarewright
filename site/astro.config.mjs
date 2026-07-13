// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  // Update `site` (and add `base` if project-pages) when the deploy target is fixed.
  site: "https://azagatti.github.io",
  integrations: [
    starlight({
      title: "Squarewright",
      description:
        "The open-source toolbox for assembling a repo-local AI code reviewer you own — on any model.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/AZagatti/squarewright",
        },
      ],
      // The marketing landing is a custom Astro page at "/"; docs start at /start/introduction.
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What Squarewright is", slug: "start/introduction" },
            { label: "Install & first review", slug: "start/quickstart" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How it works: two phases", slug: "concepts/two-phase" },
            { label: "The pieces (vocabulary)", slug: "concepts/vocabulary" },
          ],
        },
        {
          label: "Customize",
          items: [
            { label: "Models & lanes", slug: "customize/models" },
            { label: "Personas & rules", slug: "customize/personas" },
            {
              label: "Acceptance-criteria checks",
              slug: "customize/ac-conformance",
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Config (.squarewright.yml)", slug: "reference/config" },
          ],
        },
      ],
    }),
  ],
});
