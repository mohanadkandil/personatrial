"use client";
import { useEffect, useState, type ReactNode } from "react";
import { BatteryFull, Signal, Wifi } from "lucide-react";
import "./iphone.css";

export function IPhone({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(0.8);
  useEffect(() => {
    const fit = () =>
      setScale(
        Math.min(
          1,
          (window.innerHeight - (window.innerWidth < 1100 ? 240 : 76)) / 868,
          (window.innerWidth - 32) / 428,
        ),
      );
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <div
      className="iphone-canvas"
      style={{ width: 428 * scale, height: 868 * scale }}
    >
      <div
        className="device device-iphone-14-pro device-black"
        style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        <div className="device-frame">
          <div className="device-screen">
            <div className="ios-status" aria-hidden="true">
              <span>9:41</span>
              <div>
                <Signal size={16} fill="currentColor" />
                <Wifi size={17} />
                <BatteryFull size={24} />
              </div>
            </div>
            {children}
            <div className="ios-home" aria-hidden="true" />
          </div>
        </div>
        <div className="device-stripe" aria-hidden="true" />
        <div className="device-header" aria-hidden="true" />
        <div className="device-sensors" aria-hidden="true" />
        <div className="device-btns" aria-hidden="true" />
        <div className="device-power" aria-hidden="true" />
        <div className="device-home" aria-hidden="true" />
      </div>
    </div>
  );
}
