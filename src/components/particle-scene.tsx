"use client";
import { Component, type ReactNode, useEffect, useState } from "react";
import dynamic from "next/dynamic";
const ParticleObject = dynamic(() => import("./canvasui/ParticleObject"), {
  ssr: false,
});
class EffectBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
export function ParticleScene() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setEnabled(!preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  return (
    <div className="particle-scene" aria-hidden="true">
      <div className="orb-fallback" />
      {enabled && (
        <EffectBoundary>
          <ParticleObject
            src="/persona-orb.svg"
            count={18500}
            size={1.5}
            color="#e9e4d6"
            scale={3.5}
            cameraDistance={3.8}
            drift={0.25}
            strength={0.7}
            radius={95}
            swirl={0.35}
            floatIntensity={0.5}
            rotationIntensity={0.4}
            floatSpeed={0.7}
            orbit={false}
            className="particle-object"
          />
        </EffectBoundary>
      )}
    </div>
  );
}
