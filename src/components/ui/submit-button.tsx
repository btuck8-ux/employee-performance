"use client";
import * as React from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

interface SubmitButtonProps extends Omit<ButtonProps, "type"> {
  /** Text shown while the form is submitting. Defaults to "Working…" */
  pendingLabel?: string;
}

/**
 * Submit button that automatically shows a spinner + custom label while the
 * enclosing <form> is being submitted via a Server Action. Uses
 * useFormStatus from react-dom (must be a child of a <form>).
 */
export function SubmitButton({
  children,
  pendingLabel = "Working…",
  disabled,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
