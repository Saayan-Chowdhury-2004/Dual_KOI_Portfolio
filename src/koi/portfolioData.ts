/**
 * Structured portfolio data & dynamic age telemetry for Saayan Chowdhury.
 * Zero runtime dependencies. Extracted from the legacy 4-column UI so content
 * and presentation remain cleanly separated.
 */

export interface DynamicAgeBreakdown {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Dynamically calculates exact elapsed years, months, days, hours, minutes, and seconds
 * from date of birth: 18 February 2004 (local time). Never hardcodes the displayed age.
 */
export function computeDynamicAgeBreakdown(now: Date = new Date()): DynamicAgeBreakdown {
  const birthYear = 2004;
  const birthMonth = 1; // February (0-indexed)
  const birthDay = 18;

  let years = now.getFullYear() - birthYear;
  let months = now.getMonth() - birthMonth;
  let days = now.getDate() - birthDay;

  if (days < 0) {
    months -= 1;
    const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    days += prevMonthDays;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return {
    years,
    months,
    days,
    hours: now.getHours(),
    minutes: now.getMinutes(),
    seconds: now.getSeconds(),
  };
}

export interface SubjectProfile {
  name: string;
  handle: string;
  role: string;
  summary: string;
  dobLabel: string;
  dobIso: string;
  locationCity: string;
  locationState: string;
  locationCountry: string;
  postalCode: string;
}

export const SUBJECT_PROFILE: Readonly<SubjectProfile> = {
  name: "SAAYAN CHOWDHURY",
  handle: "koi@saayan-node",
  role: "Computer Science & Data Analytics · AI/ML, Edge Vision & Full-Stack Systems",
  summary:
    "Dual-degree undergraduate (IIT Patna BSc CS & Data Analytics + BTech CSE) building real-time edge computer vision pipelines, custom TCP synchronization protocols, local LLM/RAG systems, and geospatial sensing workflows.",
  dobLabel: "18 FEBRUARY 2004",
  dobIso: "2004-02-18",
  locationCity: "PANAGARH",
  locationState: "WEST BENGAL",
  locationCountry: "INDIA",
  postalCode: "713148",
};

export interface ExperienceEntry {
  index: string;
  role: string;
  organization: string;
  period: string;
  badge: string;
  tags: readonly string[];
  bullets: readonly string[];
}

export const EXPERIENCE_ITEMS: readonly ExperienceEntry[] = [
  {
    index: "01",
    role: "Virtual Intern",
    organization: "HCL GUVI",
    period: "JUL 2025 – SEP 2025",
    badge: "90-DAY PROGRAM · A+ GRADE (97/100)",
    tags: ["Python", "Pandas", "Plotly", "Mapbox", "Tkinter", "Watchdog"],
    bullets: [
      "Built an interactive India AQI mapping tool using Python, Pandas, Plotly and Mapbox on PM10 data across Indian cities (2023–2025).",
      "Built a reproducible HR data-cleaning pipeline with encoding fixes, deduplication and multi-format (CSV/Excel/JSON) ingestion.",
      "Built a modular Python Syntax Checker with batch scanning, a Tkinter GUI, real-time directory monitoring (Watchdog) and automated tests.",
    ],
  },
  {
    index: "02",
    role: "Machine Learning Intern",
    organization: "SaiKet Systems",
    period: "APR 2025 – MAY 2025",
    badge: "ML PIPELINES & ENSEMBLE MODELING",
    tags: [
      "Scikit-learn",
      "XGBoost",
      "Imbalanced-learn",
      "Matplotlib",
      "ML",
      "Classification",
      "Feature Engineering",
      "Hyperparameter Tuning",
    ],
    bullets: [
      "Developed a telecom customer churn prediction pipeline using Python, Pandas, NumPy, Scikit-learn and XGBoost.",
      "Cleaned and preprocessed customer data by handling missing values, encoding categorical variables and scaling numerical features.",
      "Trained and tuned Gradient Boosting and XGBoost classifiers using RandomizedSearchCV and analyzed feature importance to identify key churn indicators.",
      "Implemented SMOTE for class-imbalance handling and ensemble learning techniques, including soft-voting and stacking classifiers with Logistic Regression as the meta-classifier.",
      "Conducted exploratory data analysis and evaluated model performance using accuracy, precision, recall, F1-score, ROC-AUC, confusion matrices and ROC curves.",
    ],
  },
];

export interface EducationEntry {
  index: string;
  institution: string;
  qualification: string;
  dateLabel: string;
  statusTag: string;
  focusAreas: string;
  highlights: string;
}

export const EDUCATION_ITEMS: readonly EducationEntry[] = [
  {
    index: "01",
    institution: "Indian Institute of Technology (IIT) Patna",
    qualification: "BSc, Computer Science and Data Analytics",
    dateLabel: "Graduated: July 2026",
    statusTag: "DEGREE // IIT PATNA",
    focusAreas: "Statistical Modeling · Machine Learning · Data Engineering · AI Systems",
    highlights:
      "Focused on large-scale data analytics, predictive modeling, computer vision pipelines, and applied artificial intelligence.",
  },
  {
    index: "02",
    institution: "Durgapur Institute of Advanced Technology and Management",
    qualification: "BTech, Computer Science and Engineering",
    dateLabel: "Expected: 2027",
    statusTag: "B.TECH // CSE",
    focusAreas: "Systems Architecture · Operating Systems · Computer Networks · Robotics",
    highlights:
      "Core engineering curriculum covering algorithms, distributed computing, embedded hardware integration, and software design.",
  },
  {
    index: "03",
    institution: "Hem Sheela Model School",
    qualification: "Class XII, 72.00%",
    dateLabel: "Completed: 2022",
    statusTag: "HIGHER SECONDARY // XII",
    focusAreas: "Physics · Chemistry · Mathematics · Computer Science",
    highlights:
      "Senior secondary specialization in quantitative sciences and foundational programming.",
  },
  {
    index: "04",
    institution: "Hem Sheela Model School",
    qualification: "Class X, 93.5%",
    dateLabel: "Completed: 2020",
    statusTag: "SECONDARY // X (93.5%)",
    focusAreas: "Science · Mathematics · Information Technology",
    highlights:
      "Graduated with 93.5% aggregate distinction across core analytical and scientific subjects.",
  },
];

export interface SkillCategoryEntry {
  index: string;
  category: string;
  items: string;
  tags: readonly string[];
  expandedSummary: string;
}

export const SKILL_CATEGORIES: readonly SkillCategoryEntry[] = [
  {
    index: "01",
    category: "Languages",
    items: "Python, SQL, C++",
    tags: ["Python 3", "SQL", "C++", "AsyncIO", "Data Structures"],
    expandedSummary:
      "Production scripting, asynchronous backend services, relational query optimization, and low-latency algorithmic modules.",
  },
  {
    index: "02",
    category: "AI/ML",
    items: "Scikit-learn, YOLOv8, Sentence Transformers, local LLM inference (Ollama)",
    tags: ["YOLOv8", "ByteTrack", "Sentence Transformers", "Ollama LLM", "Scikit-learn"],
    expandedSummary:
      "Real-time multi-object drone detection, dense vector embeddings for semantic search, and self-hosted LLM orchestration.",
  },
  {
    index: "03",
    category: "Backend & Frontend",
    items: "FastAPI, Flask, React, REST API",
    tags: ["FastAPI", "Flask", "React", "REST APIs", "Custom TCP Sync"],
    expandedSummary:
      "High-throughput REST and custom chunked TCP protocols, webhook automation, and flicker-free live telemetry dashboards.",
  },
  {
    index: "04",
    category: "Databases",
    items: "PostgreSQL, ChromaDB, PostGIS",
    tags: ["PostgreSQL", "ChromaDB", "PostGIS", "Vector Indexing"],
    expandedSummary:
      "Relational schema design, vector similarity stores for RAG document retrieval, and geospatial query processing.",
  },
  {
    index: "05",
    category: "Robotics",
    items: "Arduino, Raspberry Pi",
    tags: ["Raspberry Pi 5", "Arduino", "UAV Telemetry", "Edge Vision"],
    expandedSummary:
      "On-board edge AI inference on Raspberry Pi 5, multi-sensor drone payload integration, and hardware telemetry sync.",
  },
  {
    index: "06",
    category: "Tools & Platforms",
    items: "Git, Docker, Linux, n8n, Blender",
    tags: ["Docker Compose", "Linux", "n8n Webhooks", "Git", "Blender", "GEE / GDAL"],
    expandedSummary:
      "Containerized microservice deployment, automated n8n ingestion workflows, geospatial raster processing, and 3D visualization.",
  },
];

export interface ProjectTopicEntry {
  id: string;
  index: string;
  heading: string;
  badge: string;
  subtitle: string;
  pipeline: string;
  techStack: readonly string[];
  bullets: readonly string[];
}

export const PROJECT_TOPICS: readonly ProjectTopicEntry[] = [
  {
    id: "drone-sync",
    index: "01",
    heading: "Autonomous Drone Detection & Data Synchronization System",
    badge: "ISRO IRoC-U 2026",
    subtitle: "ISRO IRoC-U 2026 — Team qualified through the Preliminary and Qualification Rounds",
    pipeline:
      "YOLOv8 + ByteTrack (Raspberry Pi 5) -> Custom Chunked TCP Sync (SHA-256) -> Live Telemetry Dashboard",
    techStack: ["YOLOv8", "ByteTrack", "Raspberry Pi 5", "TCP Sockets", "SHA-256", "HTML/CSS/JS"],
    bullets: [
      "Built a real-time drone detection and tracking pipeline (YOLOv8 + ByteTrack) on a Raspberry Pi 5.",
      "Engineered a custom TCP data-sync system with chunked transfer, SHA-256 verification, resume support, and priority queuing.",
      "Built a live monitoring dashboard (HTML/CSS/JS) with throttled DOM updates for flicker-free streaming.",
    ],
  },
  {
    id: "mailovertel",
    index: "02",
    heading: "MailOverTel — Self-Hosted AI Email Automation Platform",
    badge: "LOCAL LLM + DOCKER",
    subtitle: "Self-Hosted Conversational AI Email Dispatch & Provisioning Engine",
    pipeline:
      "Telegram Bot -> Python Backend -> Local Ollama LLM -> Recipient Extraction -> Gmail SMTP",
    techStack: ["Python", "Ollama LLM", "Telegram API", "Gmail SMTP", "Docker Compose", "Bash"],
    bullets: [
      "Built a self-hosted AI email automation system converting Telegram messages into structured emails via a local Ollama LLM and Gmail SMTP.",
      "Designed the pipeline: Telegram -> Python backend -> local LLM -> structured email -> Gmail SMTP, with automatic recipient extraction.",
      "Dockerized the app with Docker Compose and an automated setup script for dependencies, model provisioning, and builds.",
    ],
  },
  {
    id: "researchos",
    index: "03",
    heading: "ResearchOS — AI Research Assistant Platform",
    badge: "RAG + VECTOR SEARCH",
    subtitle: "Semantic Document Ingestion & Vector-Based Research Retrieval System",
    pipeline:
      "PDF Ingestion (PyMuPDF / n8n) -> Sentence Transformers -> ChromaDB Vector Store -> FastAPI + React",
    techStack: [
      "FastAPI",
      "React",
      "Sentence Transformers",
      "ChromaDB",
      "n8n Webhooks",
      "PyMuPDF",
      "ngrok",
    ],
    bullets: [
      "Engineered a document-ingestion and semantic-search pipeline using FastAPI, Sentence Transformers, and ChromaDB for vector-based retrieval.",
      "Built a React frontend integrated with FastAPI endpoints and automated ingestion workflows via n8n webhooks.",
      "Exposed local services through ngrok and resolved PDF-extraction (PyMuPDF) dependency issues.",
    ],
  },
  {
    id: "flying-eye",
    index: "04",
    heading: "Flying Eye — Drone-Based Intelligent ET Sensing & Irrigation System",
    badge: "SIH 2024 WINNER",
    subtitle: "Smart India Hackathon 2024 — Hardware Edition Grand Finale Winner",
    pipeline:
      "Multi-Sensor Drone Imagery -> NDVI & Penman-Monteith Modeling -> Google Earth Engine + GDAL/Rasterio",
    techStack: [
      "Google Earth Engine",
      "Rasterio",
      "GDAL",
      "NDVI",
      "Penman-Monteith",
      "Drone Sensing",
    ],
    bullets: [
      "Won the Grand Finale of Smart India Hackathon 2024 (Hardware Edition) with Team Flying Eye (1571).",
      "Designed an AET estimation workflow (NDVI, Penman-Monteith, crop-coefficient modeling) using Google Earth Engine, Rasterio, and GDAL, integrating multi-sensor drone data for field-level monitoring.",
    ],
  },
];

export interface ContactChannelEntry {
  id: string;
  index: string;
  label: string;
  protocol: string;
  value: string;
  href: string;
  external: boolean;
}

export const CONTACT_CHANNELS: readonly ContactChannelEntry[] = [
  {
    id: "phone",
    index: "01",
    label: "PHONE",
    protocol: "TEL // VOICE",
    value: "+91 8196003077",
    href: "tel:+918196003077",
    external: false,
  },
  {
    id: "email",
    index: "02",
    label: "EMAIL",
    protocol: "SMTP // MAILTO",
    value: "saayanchowdhury2184@gmail.com",
    href: "mailto:saayanchowdhury2184@gmail.com",
    external: false,
  },
  {
    id: "github",
    index: "03",
    label: "GITHUB",
    protocol: "HTTPS // GIT",
    value: "github.com/Saayan-Chowdhury-2004",
    href: "https://github.com/Saayan-Chowdhury-2004",
    external: true,
  },
  {
    id: "linkedin",
    index: "04",
    label: "LINKEDIN",
    protocol: "HTTPS // NET",
    value: "www.linkedin.com/in/saayan-chowdhury-pop2004/",
    href: "https://www.linkedin.com/in/saayan-chowdhury-pop2004/",
    external: true,
  },
];
