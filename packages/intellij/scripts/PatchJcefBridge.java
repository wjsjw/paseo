import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;
import org.jetbrains.org.objectweb.asm.ClassReader;
import org.jetbrains.org.objectweb.asm.ClassVisitor;
import org.jetbrains.org.objectweb.asm.ClassWriter;
import org.jetbrains.org.objectweb.asm.Label;
import org.jetbrains.org.objectweb.asm.MethodVisitor;
import org.jetbrains.org.objectweb.asm.Opcodes;

/** Adds the local-credential command to the existing JCEF host dispatcher. */
public final class PatchJcefBridge {
    private static final String DISPATCH_DESCRIPTOR =
        "(Ljava/lang/String;Lcom/google/gson/JsonElement;)Lcom/google/gson/JsonElement;";
    private static final String HELPER_OWNER = "sh/paseo/intellij/PaseoLocalCredentialBridge";
    private static final String HELPER_DESCRIPTOR =
        "(Lcom/google/gson/JsonElement;)Lcom/google/gson/JsonElement;";
    private static final String WEB_SERVER_RESPOND_DESCRIPTOR =
        "(Lcom/sun/net/httpserver/HttpExchange;I[BLjava/lang/String;)V";
    private static final String CSP_HEADER =
        "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' http: https: ws: wss:; base-uri 'self'; frame-ancestors 'none'";
    private static final String CSP_HEADER_WITH_PLUGIN_EVAL =
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
        "font-src 'self' data:; connect-src 'self' http: https: ws: wss:; " +
        "base-uri 'self'; frame-ancestors 'none'";

    private PatchJcefBridge() {}

    public static void main(String[] args) throws IOException {
        if (args.length != 2) {
            throw new IllegalArgumentException(
                "Expected PaseoWebview.class and PaseoWebServer.class paths."
            );
        }
        Path classFile = Path.of(args[0]);
        byte[] original = Files.readAllBytes(classFile);
        ClassReader reader = new ClassReader(original);
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        AtomicBoolean foundDispatcher = new AtomicBoolean();
        AtomicBoolean alreadyPatched = new AtomicBoolean();

        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(
                int access,
                String name,
                String descriptor,
                String signature,
                String[] exceptions
            ) {
                MethodVisitor delegate = super.visitMethod(access, name, descriptor, signature, exceptions);
                if (!"dispatch".equals(name) || !DISPATCH_DESCRIPTOR.equals(descriptor)) return delegate;
                if (!foundDispatcher.compareAndSet(false, true)) {
                    throw new IllegalStateException("Found multiple matching dispatch methods.");
                }
                return new MethodVisitor(Opcodes.ASM9, delegate) {
                    private boolean inspected;

                    @Override
                    public void visitMethodInsn(
                        int opcode,
                        String owner,
                        String methodName,
                        String methodDescriptor,
                        boolean isInterface
                    ) {
                        if (HELPER_OWNER.equals(owner) && "dispatch".equals(methodName)) {
                            alreadyPatched.set(true);
                        }
                        super.visitMethodInsn(opcode, owner, methodName, methodDescriptor, isInterface);
                    }

                    @Override
                    public void visitCode() {
                        super.visitCode();
                        Label continueDispatch = new Label();
                        super.visitVarInsn(Opcodes.ALOAD, 1);
                        super.visitLdcInsn("desktop_local_credential");
                        super.visitMethodInsn(
                            Opcodes.INVOKEVIRTUAL,
                            "java/lang/String",
                            "equals",
                            "(Ljava/lang/Object;)Z",
                            false
                        );
                        super.visitJumpInsn(Opcodes.IFEQ, continueDispatch);
                        super.visitVarInsn(Opcodes.ALOAD, 2);
                        super.visitMethodInsn(
                            Opcodes.INVOKESTATIC,
                            HELPER_OWNER,
                            "dispatch",
                            HELPER_DESCRIPTOR,
                            false
                        );
                        super.visitInsn(Opcodes.ARETURN);
                        super.visitLabel(continueDispatch);
                        super.visitFrame(Opcodes.F_SAME, 0, null, 0, null);
                        inspected = true;
                    }

                    @Override
                    public void visitMaxs(int maxStack, int maxLocals) {
                        if (!inspected) throw new IllegalStateException("Dispatcher has no code body.");
                        super.visitMaxs(maxStack, maxLocals);
                    }
                };
            }
        }, 0);

        if (!foundDispatcher.get()) {
            throw new IllegalStateException("PaseoWebview.dispatch(String, JsonElement) was not found.");
        }
        if (alreadyPatched.get()) {
            System.out.println("PaseoWebview bridge already supports desktop_local_credential.");
        } else {
            Files.write(classFile, writer.toByteArray());
            System.out.println("Patched PaseoWebview.dispatch for desktop_local_credential.");
        }
        patchPluginEvaluationCsp(Path.of(args[1]));
    }

    private static void patchPluginEvaluationCsp(Path classFile) throws IOException {
        byte[] original = Files.readAllBytes(classFile);
        ClassReader reader = new ClassReader(original);
        ClassWriter writer = new ClassWriter(reader, 0);
        AtomicBoolean foundResponder = new AtomicBoolean();
        AtomicBoolean foundPolicy = new AtomicBoolean();
        AtomicBoolean alreadyPatched = new AtomicBoolean();

        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(
                int access,
                String name,
                String descriptor,
                String signature,
                String[] exceptions
            ) {
                MethodVisitor delegate = super.visitMethod(access, name, descriptor, signature, exceptions);
                if (!"respond".equals(name) || !WEB_SERVER_RESPOND_DESCRIPTOR.equals(descriptor)) {
                    return delegate;
                }
                if (!foundResponder.compareAndSet(false, true)) {
                    throw new IllegalStateException("Found multiple matching response methods.");
                }
                return new MethodVisitor(Opcodes.ASM9, delegate) {
                    @Override
                    public void visitLdcInsn(Object value) {
                        if (CSP_HEADER_WITH_PLUGIN_EVAL.equals(value)) {
                            foundPolicy.set(true);
                            alreadyPatched.set(true);
                        } else if (CSP_HEADER.equals(value)) {
                            foundPolicy.set(true);
                            super.visitLdcInsn(CSP_HEADER_WITH_PLUGIN_EVAL);
                            return;
                        }
                        super.visitLdcInsn(value);
                    }
                };
            }
        }, 0);

        if (!foundResponder.get()) {
            throw new IllegalStateException(
                "PaseoWebServer.respond(HttpExchange, int, byte[], String) was not found."
            );
        }
        if (!foundPolicy.get()) {
            throw new IllegalStateException("The expected JCEF Content-Security-Policy was not found.");
        }
        if (alreadyPatched.get()) {
            System.out.println("Paseo JCEF Content-Security-Policy already allows trusted plugin evaluation.");
            return;
        }
        Files.write(classFile, writer.toByteArray());
        System.out.println("Patched Paseo JCEF Content-Security-Policy for trusted plugin evaluation.");
    }
}
