import { serve } from "inngest/next";
import { functions, inngest } from "@/server/jobs/functions";

export const runtime = "nodejs";
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
