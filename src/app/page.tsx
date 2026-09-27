import Link from "next/link";
import { ParticleScene } from "@/components/particle-scene";

export default function Home() {
  return (
    <main className="entry-screen">
      <div className="entry-content">
        <div className="entry-orb">
          <ParticleScene />
        </div>
        <h1>Persona Trail</h1>
        <Link className="enter-button" href="/chat">
          Begin
        </Link>
      </div>
    </main>
  );
}
