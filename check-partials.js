/**
 * Script para verificar que los parciales se han registrado correctamente
 * Ejecutar en la consola de FoundryVTT (F12)
 */

console.log("🔍 Verificando estado de parciales Handlebars...");

const partials = [
  'parts/actor-header',
  'parts/actor-navigation',
  'parts/actor-background', 
  'parts/actor-stats',
  'parts/actor-skills',
  'parts/actor-equipment'
];

partials.forEach(partialName => {
  const partial = Handlebars.partials[partialName];
  if (partial) {
    console.log(`✅ ${partialName} - Registrado correctamente`);
  } else {
    console.log(`❌ ${partialName} - NO registrado`);
  }
});

console.log("\n📋 Información adicional:");
console.log("- Total parciales registrados:", Object.keys(Handlebars.partials).length);
console.log("- Parciales RMF:", Object.keys(Handlebars.partials).filter(k => k.includes('actor')));

console.log("\n🎯 Para probar un parcial específico:");
console.log("Handlebars.partials['parts/actor-header']");
