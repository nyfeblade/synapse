export function Banner() {
  return (
    <picture className="banner">
      <source media="(prefers-color-scheme: dark)" srcSet="/media/banner-dark.svg" />
      <img
        src="/media/banner-light.svg"
        alt=""
        width={1280}
        height={360}
        fetchPriority="high"
      />
    </picture>
  );
}
