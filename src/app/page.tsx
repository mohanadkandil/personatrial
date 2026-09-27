import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { Brand, Mark } from "@/components/brand";
import { ParticleScene } from "@/components/particle-scene";

export default function Home() {
  return (
    <main className="landing">
      <header className="site-header">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#a-little-help">
            The idea <ArrowUpRight size={13} />
          </a>
          <Link className="nav-cta" href="/chat">
            Meet your Persona <ArrowRight size={15} />
          </Link>
        </nav>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" /> A little help. A lot more
            possibility.
          </div>
          <h1>
            Life is a lot.
            <br />
            Let’s make
            <br />
            room for <em>you.</em>
          </h1>
          <p>
            An assistant that gets to know you.
            <br />
            For the little things, the big plans, and everything
            <br className="desktop-break" /> taking up space in your head.
          </p>
          <Link href="/chat" className="primary-button">
            Meet your Persona <ArrowUpRight size={19} />
          </Link>
          <div className="hero-footnote">
            <span className="tiny-wave">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>{" "}
            Starts with a conversation. Goes from there.
          </div>
        </div>
        <div className="hero-art">
          <ParticleScene />
          <div className="orbit-label top">
            <span className="label-cross">+</span> A presence, not another app.
          </div>
          <div className="floating-message">
            <Mark small />
            <span>Hey. What’s on your mind?</span>
            <span className="message-cursor" />
          </div>
          <div className="orbit-label bottom">
            <span className="status-dot" /> MADE TO FEEL A LITTLE MORE HUMAN
          </div>
        </div>
        <div className="hero-index">
          <span>01 / A NEW KIND OF EVERYDAY</span>
          <span>SCROLL TO EXPLORE ↓</span>
        </div>
      </section>
      <section className="idea-section" id="a-little-help">
        <div className="section-label">LESS ON YOUR MIND</div>
        <h2>
          You don’t need another to-do list.
          <br />
          <span>You need someone in your corner.</span>
        </h2>
        <div className="idea-grid">
          <article>
            <MessageCircle size={23} strokeWidth={1.3} />
            <h3>Start anywhere.</h3>
            <p>
              A thought, a question, a messy plan. You don’t have to have it all
              figured out.
            </p>
          </article>
          <article>
            <AudioLines size={23} strokeWidth={1.3} />
            <h3>Say it your way.</h3>
            <p>
              Type a little. Talk a little. One conversation that moves with
              you.
            </p>
          </article>
          <article>
            <Sparkles size={23} strokeWidth={1.3} />
            <h3>Make a little room.</h3>
            <p>
              From finding that email to figuring out your next step. Begin with
              what matters today.
            </p>
          </article>
        </div>
      </section>
      <footer className="site-footer">
        <Brand />
        <span>An independent onboarding concept.</span>
        <Link href="/chat">
          Let’s begin <ArrowUpRight size={15} />
        </Link>
      </footer>
    </main>
  );
}
