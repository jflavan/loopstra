/** A standard as the examples give it: the parts `StandardForm` (src/standards.ts) holds. */
interface ExampleForm {
  name: string;
  title: string;
  patterns: string[];
  needsPerson: boolean;
  check: string;
  rules: { label: string; text: string }[];
  context: string;
}

/**
 * The README's two examples (an architecture standard for every change; SOC 2 technical controls on
 * services/** and infra/** with a base-aware secret scanner): plain strings with no imports, so the
 * console's page and `loopstra setup standards` offer the same texts.
 */
export const STANDARD_EXAMPLES: { label: string; form: ExampleForm }[] = [
  {
    label: "Architecture, for every change",
    form: {
      name: "architecture", title: "Architecture", patterns: [], needsPerson: false, check: "",
      context: "How the code is laid out, and why. Link the design records in docs/adr/ and show examples of the right way: sessions are given the whole file.",
      rules: [
        { label: "ARCH-1", text: "Modules use each other only through what they export. No module reaches into another's internals or its database tables." },
        { label: "ARCH-2", text: "New persistent data goes through the repository layer, never straight from a handler to the database." },
        { label: "ARCH-3", text: "A change to how the system is laid out comes with a design record in docs/adr/." },
      ],
    },
  },
  {
    label: "SOC 2 technical controls, for services/** and infra/**",
    form: {
      name: "soc2", title: "SOC 2 technical controls", patterns: ["services/**", "infra/**"], needsPerson: false,
      check: 'gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"',
      context: "The controls our SOC 2 report relies on, as far as code can keep them. The check scans only what a change adds for secrets.",
      rules: [
        { label: "SOC2-CC6.1", text: "Every endpoint that reads or changes customer data checks who is calling and that their role allows it." },
        { label: "SOC2-CC7.2", text: "Access to customer data is written to the audit log: who, what and when." },
        { label: "SOC2-CC6.7", text: "Data is encrypted in transit (TLS) and at rest." },
        { label: "SOC2-CC6.8", text: "No secrets or personal data in logs, error messages or source code." },
        { label: "SOC2-C1.2", text: "Customer data is kept and deleted on the schedule in the data retention policy." },
      ],
    },
  },
];
