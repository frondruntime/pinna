export const siteName = "Pinna";
export const siteUrl = "https://pinna.frondruntime.dev";
export const siteDescription =
  "Pinna — reactive state that’s hard to get wrong. Synchronous state for domain models, built so the usual state bugs cannot happen and the rest fail where you, or your agent, can see them.";
export const ogImage = `${siteUrl}/og-image.png`;
export const ogImageAlt = "Pinna — reactive state that’s hard to get wrong";

export const siteAuthor = {
  name: "Roman Dubinin",
  url: "https://romanonthego.dev",
  id: "https://romanonthego.dev/#person",
  twitterHandle: "@romanonthego",
  sameAs: [
    "https://github.com/romanonthego",
    "https://x.com/romanonthego",
    "https://www.linkedin.com/in/romanonthego/",
  ],
} as const;

export const projectOrganizationUrl = "https://github.com/frondruntime";
export const projectRepositoryUrl = "https://github.com/frondruntime/pinna";
export const projectIdentityLinks = [projectOrganizationUrl, projectRepositoryUrl] as const;
/**
 * The publisher both Pinna's and Frond's sites name. The `@id` and its facts
 * match Frond's site, so the two graphs describe one organization.
 */
export const projectOrganization = {
  id: "https://frondruntime.dev/#organization",
  name: "Frond",
  url: "https://frondruntime.dev",
} as const;
export const projectLicenseUrl = "https://opensource.org/licenses/MIT";

interface JsonLdInput {
  title: string;
  description: string;
  url: string;
}

export function createJsonLd({ title, description, url }: JsonLdInput) {
  const pageIdUrl = url === siteUrl ? `${siteUrl}/` : url;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Person",
        "@id": siteAuthor.id,
        name: siteAuthor.name,
        url: siteAuthor.url,
        sameAs: [...siteAuthor.sameAs],
      },
      {
        "@type": "Organization",
        "@id": projectOrganization.id,
        name: projectOrganization.name,
        url: projectOrganization.url,
        sameAs: [projectOrganizationUrl],
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: siteName,
        url: siteUrl,
        description: siteDescription,
        inLanguage: "en-US",
        author: { "@id": siteAuthor.id },
        publisher: { "@id": projectOrganization.id },
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": `${siteUrl}/#software`,
        name: siteName,
        url: siteUrl,
        description: siteDescription,
        programmingLanguage: "TypeScript",
        codeRepository: projectRepositoryUrl,
        license: projectLicenseUrl,
        sameAs: [projectRepositoryUrl],
        image: ogImage,
        author: { "@id": siteAuthor.id },
        publisher: { "@id": projectOrganization.id },
      },
      {
        "@type": "WebPage",
        "@id": `${pageIdUrl}#webpage`,
        url,
        name: title,
        description,
        inLanguage: "en-US",
        isPartOf: { "@id": `${siteUrl}/#website` },
        author: { "@id": siteAuthor.id },
        about: { "@id": `${siteUrl}/#software` },
      },
    ],
  };
}
