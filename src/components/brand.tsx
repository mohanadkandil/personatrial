import Link from "next/link";
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span aria-hidden="true" className={`brand-mark ${small ? "small" : ""}`}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Persona home">
      <Mark />
      persona<span className="brand-period">.</span>
    </Link>
  );
}
