/**
 * Grouped certificates, awards & event photography for the 秘術 Archive Scroll.
 *
 * Similar certificates and event photos are grouped into a single tile (`slides[]`).
 * Clicking a tile opens the lightbox on its cover slide, and `<` / `>` step through
 * all images belonging to that group.
 */

export type GalleryMediaMap = typeof import("./galleryMediaData");
export type GalleryMediaKey = keyof GalleryMediaMap;

let mediaPromise: Promise<GalleryMediaMap> | null = null;

export function loadGalleryMedia(): Promise<GalleryMediaMap> {
  if (!mediaPromise) {
    mediaPromise = import("./galleryMediaData");
  }
  return mediaPromise;
}

export type GalleryItemCategory = "Award" | "Certificate" | "Competition" | "Talk";

export interface GallerySlide {
  readonly id: string;
  readonly label: string;
  readonly caption: string;
  readonly mediaKey: GalleryMediaKey;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface GalleryScrollItem {
  readonly id: string;
  readonly title: string;
  readonly jpLabel: string;
  readonly category: GalleryItemCategory;
  readonly year: string;
  readonly issuerOrMedium: string;
  readonly contextNote: string;
  readonly slides: readonly GallerySlide[];
}

export const GALLERY_SCROLL_ITEMS: readonly GalleryScrollItem[] = [
  {
    id: "sih-2024-winner",
    title: "Smart India Hackathon 2024 — Winner",
    jpLabel: "優勝・全国大会",
    category: "Award",
    year: "2024",
    issuerOrMedium: "Ministry of Education & AICTE · Hardware Edition",
    contextNote:
      "Winner of the Smart India Hackathon 2024 Hardware Edition Grand Finale (Dec 11–15, 2024) at Galgotias University Nodal Centre with Team Flying Eye (1571).",
    slides: [
      {
        id: "sih-2024-cert",
        label: "Winner Certificate",
        caption:
          "Official Smart India Hackathon 2024 Hardware Edition Grand Finale Winner Certificate issued by the Ministry of Education, AICTE, and MoE's Innovation Cell.",
        mediaKey: "SIH_AWARD_URI",
        naturalWidth: 1024,
        naturalHeight: 723,
      },
      {
        id: "sih-2024-stage",
        label: "Grand Finale Stage Photo",
        caption:
          "Team Flying Eye (1571) receiving the Smart India Hackathon 2024 Hardware Edition Winner award and ₹25,000 prize cheque at Galgotias University Nodal Centre.",
        mediaKey: "SIH_PHOTO_URI",
        naturalWidth: 1080,
        naturalHeight: 1080,
      },
    ],
  },
  {
    id: "esummit-25-innothon",
    title: "IIIT Bhubaneswar E-SUMMIT '25 — Innothon",
    jpLabel: "参加証・競技開発",
    category: "Competition",
    year: "2025",
    issuerOrMedium: "IIIT Bhubaneswar · Code-X-Novas & E-Cell",
    contextNote:
      "Participated with Team Tech Wizards in the Innothon national-level hackathon during IIIT Bhubaneswar's E-SUMMIT '25 (Jan 31 – Feb 2, 2025).",
    slides: [
      {
        id: "esummit-25-cert",
        label: "Certificate of Participation",
        caption:
          "Certificate of Participation for Team Tech Wizards at the Innothon national-level hackathon, IIIT Bhubaneswar E-SUMMIT '25.",
        mediaKey: "ESUMMIT_URI",
        naturalWidth: 1024,
        naturalHeight: 723,
      },
    ],
  },
  {
    id: "ihmmc-2025",
    title: "IHMMC 2025 — Best Innovative Idea (4th)",
    jpLabel: "表彰・機構設計",
    category: "Award",
    year: "2025",
    issuerOrMedium: "Asansol Engineering College · International Level",
    contextNote:
      "Secured 4th position and the Best Innovative Idea Special Award with Team 244 Flying Eye at the Innovative Hardware Model Making Competition (IHMMC 2025, Mar 6–7, 2025).",
    slides: [
      {
        id: "ihmmc-2025-portrait",
        label: "Trophy, Medal & Certificate",
        caption:
          "Certificate of Appreciation, gold medal, and 4th-position trophy for Best Innovative Idea at IHMMC 2025 (Team 244 — Flying Eye).",
        mediaKey: "IHMMC_PORTRAIT_URI",
        naturalWidth: 1204,
        naturalHeight: 1600,
      },
      {
        id: "ihmmc-2025-stage",
        label: "Stage Award Ceremony",
        caption:
          "On-stage felicitation at Asansol Engineering College receiving the IHMMC '25 Best Innovative Idea trophy, certificate, and prize cheque.",
        mediaKey: "IHMMC_STAGE_URI",
        naturalWidth: 1600,
        naturalHeight: 1204,
      },
    ],
  },
  {
    id: "hcl-guvi-iit-patna-2025",
    title: "HCL GUVI × IIT Patna — 90-Day Virtual Internship",
    jpLabel: "修了証・実習評価",
    category: "Certificate",
    year: "2025",
    issuerOrMedium: "HCL GUVI & IIT Patna · Grade A+ (97/100)",
    contextNote:
      "Certificate of Recognition for completing the 90 Days Virtual Internship Program powered by HCL GUVI for IIT Patna students (July–September 2025) with Grade A+ and 97 marks (ID: o97AP1z7f66I608934).",
    slides: [
      {
        id: "hcl-guvi-cert",
        label: "Certificate of Recognition",
        caption:
          "Verified Certificate of Recognition (ID: o97AP1z7f66I608934) — Performance Grade: A+, Marks: 97, completed 30 September 2025.",
        mediaKey: "HCL_GUVI_URI",
        naturalWidth: 1620,
        naturalHeight: 1080,
      },
    ],
  },
  {
    id: "guest-speaker-session",
    title: "Guest Speaker — Experience & Innovation Talk",
    jpLabel: "講演・登壇記録",
    category: "Talk",
    year: "2025",
    issuerOrMedium: "Invited Guest Speaker · On-Stage Session",
    contextNote:
      "Invited guest talk sharing practical lessons from national-level hardware hackathons, prototyping under constraints, and engineering competitions.",
    slides: [
      {
        id: "chief-guest-stage",
        label: "On-Stage Talk",
        caption:
          "Delivering an invited guest session on stage — sharing hands-on experience from national hackathons and hardware engineering.",
        mediaKey: "CHIEF_GUEST_URI",
        naturalWidth: 768,
        naturalHeight: 1024,
      },
    ],
  },
  {
    id: "eisf-bitm-2026",
    title: "Eastern India Science & Engineering Fair — Best Applied Tech",
    jpLabel: "受賞・科学技術展",
    category: "Award",
    year: "2024–2026",
    issuerOrMedium: "Birla Industrial & Technological Museum (NCSM), Kolkata",
    contextNote:
      "Winner of the Best Applied Technology Project Award (₹5,000 prize & trophy) at the Eastern India Science & Engineering Fair 2026 at BITM, Kolkata, alongside live model demonstrations at EISF 2024.",
    slides: [
      {
        id: "eisf-2026-stage",
        label: "EISF 2026 Award Ceremony",
        caption:
          "Receiving the Best Applied Technology Project Award trophy and certificates on stage at the Eastern India Science & Engineering Fair 2026, Birla Industrial & Technological Museum, Kolkata (Jan 16, 2026).",
        mediaKey: "EISF_2026_STAGE_URI",
        naturalWidth: 928,
        naturalHeight: 519,
      },
      {
        id: "eisf-2026-team",
        label: "Team, Trophy & Prize Cheque",
        caption:
          "Team celebrating with the Best Applied Technology Project Award trophy, certificates, and ₹5,000 prize cheque at Science & Engineering Fair 2026.",
        mediaKey: "EISF_2026_TEAM_URI",
        naturalWidth: 920,
        naturalHeight: 517,
      },
      {
        id: "eisf-2024-demo",
        label: "EISF 2024 Live Demonstration",
        caption:
          "Demonstrating the smart traffic intersection hardware prototype to judges during the Eastern India Science & Engineering Fair 2024 at BITM, Kolkata (Jan 9, 2024).",
        mediaKey: "EISF_2024_DEMO_URI",
        naturalWidth: 1600,
        naturalHeight: 1204,
      },
    ],
  },
  {
    id: "be10x-ai-workshop-2026",
    title: "be10X — AI Tools & ChatGPT Workshop",
    jpLabel: "認定証・人工知能",
    category: "Certificate",
    year: "2026",
    issuerOrMedium: "be10X · Verified Workshop Completion",
    contextNote:
      "Completed the be10X AI Tools and ChatGPT Workshop (May 17, 2026), covering AI-assisted data analysis, debugging, and rapid technical workflows.",
    slides: [
      {
        id: "be10x-cert",
        label: "Certificate of Completion",
        caption:
          "be10X Verified Certificate of Completion for the AI Tools and ChatGPT Workshop, issued May 17, 2026.",
        mediaKey: "BE10X_URI",
        naturalWidth: 1024,
        naturalHeight: 682,
      },
    ],
  },
  {
    id: "meditech-expo-2026",
    title: "MediTech Expo 2026 — Award of Excellence",
    jpLabel: "優秀賞・技術展示",
    category: "Award",
    year: "2026",
    issuerOrMedium: "Rahul Foundation · Tech Exhibition 2025–26",
    contextNote:
      "Awarded the Certificate of Achievement and Award of Excellence medal at Rahul Foundation's MediTech Expo 2026 (Nov 21, 2026) representing DIATM CSE.",
    slides: [
      {
        id: "meditech-2026-cert",
        label: "Certificate & Medal",
        caption:
          "MediTech Expo 2026 Certificate of Achievement paired with the Rahul Foundation Award of Excellence medal (21.11.2026).",
        mediaKey: "MEDITECH_CERT_URI",
        naturalWidth: 1600,
        naturalHeight: 1204,
      },
      {
        id: "meditech-2026-stage",
        label: "Award Presentation",
        caption:
          "Receiving the framed MediTech Expo 2026 Award of Excellence certificate on stage during the Rahul Foundation ceremony.",
        mediaKey: "MEDITECH_STAGE_URI",
        naturalWidth: 940,
        naturalHeight: 1024,
      },
    ],
  },
];

export function getGalleryCoverMediaKey(item: GalleryScrollItem): GalleryMediaKey | undefined {
  return item.slides[0]?.mediaKey;
}
