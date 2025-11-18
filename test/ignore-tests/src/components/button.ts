export interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label }: ButtonProps): string {
  return `Button(${label})`;
}
