import type { Metadata } from "next";
import AutoproverDashboard from "./components/AutoproverDashboard";

export const metadata: Metadata = {
  title: "Continuous Math Research",
  description:
    "Run, rank, and inspect parallel AI research campaigns against open mathematical problems.",
};

export default function Home() {
  return <AutoproverDashboard />;
}
