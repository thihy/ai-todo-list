# Preserve conversation state across Stop and Send

An old ai.ask reply can clear a newer invocation in the same conversation and overwrite a cancelled turn. User questions also infer their owner from the first active conversation instead of the DSH caller.

Store active invocation identity atomically, preserve cancelled turns on late updates, and route pending questions using the calling agent through main and renderer.
