// Files the build embeds as text.
declare module "*.template" {
  const text: string;
  export default text;
}
