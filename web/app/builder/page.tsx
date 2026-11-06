import type { Metadata } from "next";
import { PipelineStudio } from "@/components/pipeline/PipelineStudio";

export const metadata: Metadata = {
  title: "Pipeline Studio",
  description: "Build model-neutral pipelines and chat with your own models.",
};

export default function BuilderPage() {
  return <PipelineStudio />;
}
