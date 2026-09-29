import Image from "next/image";

export function Shot({
  src,
  caption,
  wide = false,
}: {
  src: string;
  caption: string;
  wide?: boolean;
}) {
  return (
    <figure className={wide ? "shot shot-wide" : "shot"}>
      <Image
        src={src}
        alt={caption}
        width={1600}
        height={1000}
        sizes={wide ? "(min-width: 1100px) 1040px, 100vw" : "(min-width: 1100px) 500px, 100vw"}
      />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
