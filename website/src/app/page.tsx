import Link from "next/link";
import { Banner } from "@/components/Banner";
import { Features, Intro, PrivacyPoints, Requirements } from "@/components/product-copy";
import { Shot } from "@/components/Shot";

export default function HomePage() {
  return (
    <div className="wrap home">
      <h1 className="sr-only">Synapse: your own team of AI Bots, on your Mac.</h1>
      <Banner />
      <Intro />
      <div className="actions">
        <Link className="button" href="/download">
          Download
        </Link>
        <Link className="button button-quiet" href="/docs">
          Docs
        </Link>
      </div>

      <section className="section" aria-labelledby="chat-shot">
        <h2 id="chat-shot" className="sr-only">
          A Bot at work
        </h2>
        <Shot
          wide
          src="/media/screenshot-chat.png"
          caption="Synapse: a Bot at work, with its plan, your Mac and an approval card"
        />
      </section>

      <section className="section" aria-labelledby="features-title">
        <h2 id="features-title">Features</h2>
        <Features />
        <div className="shot-row">
          <Shot src="/media/screenshot-code.png" caption="A Bot coding in a repo" />
          <Shot src="/media/screenshot-call.png" caption="A voice call" />
        </div>
      </section>

      <section className="section" aria-labelledby="requirements-title">
        <h2 id="requirements-title">Requirements</h2>
        <div className="prose">
          <Requirements />
          <p>
            <Link href="/docs/install">Install steps</Link>
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="privacy-title">
        <h2 id="privacy-title">Privacy and security</h2>
        <PrivacyPoints />
        <p>
          <Link href="/privacy">Privacy, reporting and the licence</Link>
        </p>
      </section>
    </div>
  );
}
