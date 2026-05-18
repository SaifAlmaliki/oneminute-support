type SourceType = "website" | "docs" | "upload" | "text";
type SourceStatus = "active" | "training" | "error" | "excluded";
type SectionStatus = "active" | "draft" | "disabled";
type Tone = "strict" | "neutral" | "friendly" | "empathetic";

interface KnowledgeSource {
    id: string;
    user_email: string;
    type: string;
    name: string;
    status: string;
    source_url: string | null;
    content: string | null;
    meta_data: string | null;
    last_updated: string | null;
    created_at: string | null;
}

interface SectionFormData {
  name: string;
  description: string;
  tone: Tone;
  allowedTopics: string;
  blockedTopics: string;
  fallbackBehavior: string;
}

interface Section {
  id: string;
  name: string;
  description: string;
  sourceCount: number;
  source_ids?: string[];
  tone: Tone;
  scopeLabel: string;
  allowed_topics?: string;
  blocked_topics?: string;
  status: SectionStatus;
}