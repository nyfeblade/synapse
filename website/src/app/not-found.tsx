import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap home">
      <h1>That page is not on this site.</h1>
      <p>
        <Link href="/">Home</Link>
        {" · "}
        <Link href="/docs">Docs</Link>
        {" · "}
        <Link href="/download">Download</Link>
      </p>
    </div>
  );
}
